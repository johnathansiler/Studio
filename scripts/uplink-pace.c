/**
 * One shared uplink for every socket in this process tree.
 * Chrome's network service and WebRTC process are separate, so the token
 * bucket lives in shared memory. A 1 MB write and a video packet take turns
 * on the same timeline, which is what a cellular radio does and what
 * per-connection devtools throttling does not.
 *
 *   UPLINK_BPS         bytes per second (default 125000, about 1 Mbps)
 *   UPLINK_LATENCY_MS  added delay per send (default 150)
 *   UPLINK_SHM         shared bucket path
 *   UPLINK_ARM         if set, pacing starts only once this file exists
 *
 * Carrier mode, also gated on UPLINK_ARM, used by the prod test:
 *   UPLINK_RELAY_UDP=1          drop UDP that is not DNS, STUN, or TURN 3478
 *   UPLINK_UDP_HOLD_MS          also drop TURN UDP until this long after arm
 *   UPLINK_TCP_DOWN_START_MS    reset remote TCP from this time
 *   UPLINK_TCP_DOWN_END_MS      until this time (a multi-second blackhole)
 *   UPLINK_TCP_KILL_EVERY_MS    after the blackhole, reset remote TCP again
 *                               on a short pulse at each interval
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <time.h>
#include <unistd.h>

struct Bucket {
  pthread_mutex_t mu;
  double next_ms;
  /* While this time is in the future, a large write owns the uplink.
     Video and signaling wait it out instead of slipping between socket chunks. */
  double bulk_until;
  int ready;
};

static struct Bucket *bucket;
static double rate_bps = 125000;
static double latency_ms = 150;
static char *arm_path;
static int armed;
static double armed_at;
static int relay_udp;
static double udp_hold_ms;
static double tcp_down_start_ms;
static double tcp_down_end_ms;
static double tcp_kill_every_ms;

static double now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}

static void sleep_ms(double ms) {
  if (ms <= 0.5) return;
  struct timespec ts;
  ts.tv_sec = (time_t)(ms / 1000.0);
  ts.tv_nsec = (long)((ms - ts.tv_sec * 1000.0) * 1e6);
  while (nanosleep(&ts, &ts) != 0 && errno == EINTR) {
  }
}

static int is_socket(int fd) {
  struct stat st;
  if (fstat(fd, &st) != 0) return 0;
  return S_ISSOCK(st.st_mode);
}

static int socket_type(int fd) {
  int type = 0;
  socklen_t len = sizeof(type);
  if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &len) != 0) return 0;
  return type;
}

static int tcp_socket(int fd) {
  return socket_type(fd) == SOCK_STREAM;
}

static int udp_socket(int fd) {
  return socket_type(fd) == SOCK_DGRAM;
}

/* Chrome's renderer talks to the network service over Unix sockets.
   Pacing those stalls the page itself. Only the IP path is the shared radio. */
static int internet_socket(int fd) {
  int domain = 0;
  socklen_t len = sizeof(domain);
  if (getsockopt(fd, SOL_SOCKET, SO_DOMAIN, &domain, &len) != 0) return 0;
  return domain == AF_INET || domain == AF_INET6;
}

static char *dup_env(const char *key) {
  const char *value = getenv(key);
  if (!value || !value[0]) return NULL;
  size_t n = strlen(value);
  char *copy = (char *)malloc(n + 1);
  if (!copy) return NULL;
  memcpy(copy, value, n + 1);
  return copy;
}

static double env_ms(const char *key) {
  const char *value = getenv(key);
  if (!value || !value[0]) return 0;
  return atof(value);
}

static void ensure_armed(void) {
  if (armed) return;
  if (arm_path && access(arm_path, F_OK) != 0) return;
  armed = 1;
  armed_at = now_ms();
}

static int port_of(const struct sockaddr *addr) {
  if (!addr) return 0;
  if (addr->sa_family == AF_INET) return ntohs(((const struct sockaddr_in *)addr)->sin_port);
  if (addr->sa_family == AF_INET6) return ntohs(((const struct sockaddr_in6 *)addr)->sin6_port);
  return 0;
}

static int loopback_addr(const struct sockaddr *addr) {
  if (!addr) return 0;
  if (addr->sa_family == AF_INET) {
    return ((const struct sockaddr_in *)addr)->sin_addr.s_addr == htonl(0x7f000001);
  }
  if (addr->sa_family == AF_INET6) {
    const struct sockaddr_in6 *in6 = (const struct sockaddr_in6 *)addr;
    if (IN6_IS_ADDR_LOOPBACK(&in6->sin6_addr)) return 1;
    if (IN6_IS_ADDR_V4MAPPED(&in6->sin6_addr)) {
      const uint8_t *b = in6->sin6_addr.s6_addr;
      return b[12] == 127;
    }
  }
  return 0;
}

/* Devtools and the local page stay up. Remote TCP, and TURN on loopback, do not. */
static int spared_tcp(int fd) {
  struct sockaddr_storage addr;
  socklen_t len = sizeof(addr);
  if (getpeername(fd, (struct sockaddr *)&addr, &len) != 0) return 1;
  /* Chrome's broker uses Unix sockets. Resetting those kills the browser, not the carrier path. */
  if (addr.ss_family != AF_INET && addr.ss_family != AF_INET6) return 1;
  int port = port_of((struct sockaddr *)&addr);
  if (port <= 0) return 1;
  if (!loopback_addr((struct sockaddr *)&addr)) return 0;
  if (port == 80 || port == 443 || port == 3478 || port == 5349) return 0;
  return 1;
}

static int tcp_down_now(void) {
  if (!tcp_down_end_ms && !tcp_kill_every_ms) return 0;
  ensure_armed();
  if (!armed || !armed_at) return 0;
  double dt = now_ms() - armed_at;
  if (tcp_down_end_ms > 0 && dt >= tcp_down_start_ms && dt < tcp_down_end_ms) return 1;
  if (tcp_kill_every_ms <= 0 || dt < tcp_down_end_ms) return 0;
  double since = dt - tcp_down_end_ms;
  if (since < tcp_kill_every_ms) return 0;
  double into = since - ((int)(since / tcp_kill_every_ms)) * tcp_kill_every_ms;
  return into < 200;
}

static int reject_tcp(int fd) {
  if (!tcp_socket(fd) || !tcp_down_now()) return 0;
  if (spared_tcp(fd)) return 0;
  shutdown(fd, SHUT_RDWR);
  errno = ECONNRESET;
  return 1;
}

static int swallow_udp(int fd, const struct sockaddr *addr) {
  if (!relay_udp || !udp_socket(fd)) return 0;
  ensure_armed();
  if (!armed) return 0;
  struct sockaddr_storage peer;
  if (!addr) {
    socklen_t len = sizeof(peer);
    if (getpeername(fd, (struct sockaddr *)&peer, &len) != 0) return 0;
    addr = (struct sockaddr *)&peer;
  }
  int port = port_of(addr);
  if (port == 53 || port == 19302) return 0;
  if (port == 3478) return udp_hold_ms > 0 && now_ms() < armed_at + udp_hold_ms;
  return 1;
}

static void pace(int fd, size_t n) {
  if (!bucket || n == 0 || rate_bps < 1 || !internet_socket(fd)) return;
  if (!armed) {
    if (arm_path && access(arm_path, F_OK) != 0) return;
    armed = 1;
    if (!armed_at) armed_at = now_ms();
  }
  /* A 1 MB WebSocket write is TCP and is split into 64 KB chunks. Those own
     the uplink, so RTP waits. A 16 KB asset upload and UDP video do not. */
  const int bulk = tcp_socket(fd) && n >= 32768;
  double start = 0;
  for (;;) {
    int rc = pthread_mutex_lock(&bucket->mu);
    if (rc == EOWNERDEAD) pthread_mutex_consistent(&bucket->mu);
    double now = now_ms();
    if (!bulk && bucket->bulk_until > now + 1) {
      double wake = bucket->bulk_until;
      pthread_mutex_unlock(&bucket->mu);
      sleep_ms(wake - now_ms());
      continue;
    }
    if (bucket->next_ms < now) bucket->next_ms = now + (bulk ? 0 : latency_ms);
    start = bucket->next_ms;
    double dur = (n * 1000.0) / rate_bps;
    if (!bulk && dur > 30) dur = 30;
    bucket->next_ms = start + dur;
    if (bulk) bucket->bulk_until = bucket->next_ms + 200;
    pthread_mutex_unlock(&bucket->mu);
    break;
  }
  sleep_ms(start - now_ms());
}

__attribute__((constructor)) static void uplink_init(void) {
  const char *rate = getenv("UPLINK_BPS");
  const char *latency = getenv("UPLINK_LATENCY_MS");
  const char *path = getenv("UPLINK_SHM");
  if (rate && atof(rate) > 0) rate_bps = atof(rate);
  if (latency) latency_ms = atof(latency);
  arm_path = dup_env("UPLINK_ARM");
  relay_udp = getenv("UPLINK_RELAY_UDP") ? 1 : 0;
  udp_hold_ms = env_ms("UPLINK_UDP_HOLD_MS");
  tcp_down_start_ms = env_ms("UPLINK_TCP_DOWN_START_MS");
  tcp_down_end_ms = env_ms("UPLINK_TCP_DOWN_END_MS");
  tcp_kill_every_ms = env_ms("UPLINK_TCP_KILL_EVERY_MS");
  if (tcp_down_end_ms < tcp_down_start_ms) tcp_down_end_ms = tcp_down_start_ms;
  if (!path || !path[0]) path = "/tmp/cueharbor-uplink-bucket";
  int fd = open(path, O_RDWR | O_CREAT, 0666);
  if (fd < 0) return;
  if (ftruncate(fd, sizeof(struct Bucket)) != 0) {
    close(fd);
    return;
  }
  void *mem = mmap(NULL, sizeof(struct Bucket), PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (mem == MAP_FAILED) {
    close(fd);
    return;
  }
  bucket = mem;
  flock(fd, LOCK_EX);
  if (bucket->ready != 0xC0FFEE) {
    pthread_mutexattr_t attr;
    pthread_mutexattr_init(&attr);
    pthread_mutexattr_setpshared(&attr, PTHREAD_PROCESS_SHARED);
    pthread_mutexattr_setrobust(&attr, PTHREAD_MUTEX_ROBUST);
    pthread_mutex_init(&bucket->mu, &attr);
    pthread_mutexattr_destroy(&attr);
    bucket->next_ms = 0;
    bucket->ready = 0xC0FFEE;
  }
  flock(fd, LOCK_UN);
}

ssize_t send(int fd, const void *buf, size_t n, int flags) {
  static ssize_t (*real)(int, const void *, size_t, int);
  if (!real) real = dlsym(RTLD_NEXT, "send");
  if (reject_tcp(fd)) return -1;
  if (swallow_udp(fd, NULL)) return (ssize_t)n;
  if (is_socket(fd)) pace(fd, n);
  return real(fd, buf, n, flags);
}

ssize_t sendto(int fd, const void *buf, size_t n, int flags, const struct sockaddr *addr, socklen_t len) {
  static ssize_t (*real)(int, const void *, size_t, int, const struct sockaddr *, socklen_t);
  if (!real) real = dlsym(RTLD_NEXT, "sendto");
  if (reject_tcp(fd)) return -1;
  if (swallow_udp(fd, addr)) return (ssize_t)n;
  if (is_socket(fd)) pace(fd, n);
  return real(fd, buf, n, flags, addr, len);
}

ssize_t sendmsg(int fd, const struct msghdr *msg, int flags) {
  static ssize_t (*real)(int, const struct msghdr *, int);
  if (!real) real = dlsym(RTLD_NEXT, "sendmsg");
  size_t n = 0;
  if (msg) {
    for (size_t i = 0; i < msg->msg_iovlen; i++) n += msg->msg_iov[i].iov_len;
  }
  if (reject_tcp(fd)) return -1;
  if (msg && swallow_udp(fd, (const struct sockaddr *)msg->msg_name)) return (ssize_t)n;
  if (is_socket(fd)) pace(fd, n);
  return real(fd, msg, flags);
}

int sendmmsg(int fd, struct mmsghdr *msgvec, unsigned int vlen, int flags) {
  static int (*real)(int, struct mmsghdr *, unsigned int, int);
  if (!real) real = dlsym(RTLD_NEXT, "sendmmsg");
  size_t n = 0;
  if (msgvec) {
    for (unsigned int i = 0; i < vlen; i++) {
      struct iovec *iov = msgvec[i].msg_hdr.msg_iov;
      for (size_t j = 0; j < msgvec[i].msg_hdr.msg_iovlen; j++) n += iov[j].iov_len;
    }
  }
  if (reject_tcp(fd)) return -1;
  if (msgvec && vlen && swallow_udp(fd, (const struct sockaddr *)msgvec[0].msg_hdr.msg_name)) return (int)vlen;
  if (is_socket(fd)) pace(fd, n);
  return real(fd, msgvec, vlen, flags);
}

ssize_t write(int fd, const void *buf, size_t n) {
  static ssize_t (*real)(int, const void *, size_t);
  if (!real) real = dlsym(RTLD_NEXT, "write");
  if (reject_tcp(fd)) return -1;
  if (swallow_udp(fd, NULL)) return (ssize_t)n;
  if (is_socket(fd)) pace(fd, n);
  return real(fd, buf, n);
}

ssize_t writev(int fd, const struct iovec *iov, int iovcnt) {
  static ssize_t (*real)(int, const struct iovec *, int);
  if (!real) real = dlsym(RTLD_NEXT, "writev");
  size_t n = 0;
  if (iov) {
    for (int i = 0; i < iovcnt; i++) n += iov[i].iov_len;
  }
  if (reject_tcp(fd)) return -1;
  if (swallow_udp(fd, NULL)) return (ssize_t)n;
  if (is_socket(fd)) pace(fd, n);
  return real(fd, iov, iovcnt);
}

static int dropped_udp_source(int fd, const struct sockaddr *addr) {
  if (!relay_udp || !udp_socket(fd)) return 0;
  return swallow_udp(fd, addr);
}

ssize_t recv(int fd, void *buf, size_t n, int flags) {
  static ssize_t (*real)(int, void *, size_t, int);
  if (!real) real = dlsym(RTLD_NEXT, "recv");
  if (reject_tcp(fd)) return -1;
  ssize_t got = real(fd, buf, n, flags);
  if (got > 0 && dropped_udp_source(fd, NULL)) {
    sleep_ms(1);
    errno = EAGAIN;
    return -1;
  }
  return got;
}

ssize_t recvfrom(int fd, void *buf, size_t n, int flags, struct sockaddr *addr, socklen_t *len) {
  static ssize_t (*real)(int, void *, size_t, int, struct sockaddr *, socklen_t *);
  if (!real) real = dlsym(RTLD_NEXT, "recvfrom");
  if (reject_tcp(fd)) return -1;
  ssize_t got = real(fd, buf, n, flags, addr, len);
  if (got > 0 && dropped_udp_source(fd, addr)) {
    sleep_ms(1);
    errno = EAGAIN;
    return -1;
  }
  return got;
}

ssize_t recvmsg(int fd, struct msghdr *msg, int flags) {
  static ssize_t (*real)(int, struct msghdr *, int);
  if (!real) real = dlsym(RTLD_NEXT, "recvmsg");
  if (reject_tcp(fd)) return -1;
  ssize_t got = real(fd, msg, flags);
  if (got > 0 && msg && dropped_udp_source(fd, (struct sockaddr *)msg->msg_name)) {
    sleep_ms(1);
    errno = EAGAIN;
    return -1;
  }
  return got;
}

ssize_t read(int fd, void *buf, size_t n) {
  static ssize_t (*real)(int, void *, size_t);
  if (!real) real = dlsym(RTLD_NEXT, "read");
  if (is_socket(fd) && reject_tcp(fd)) return -1;
  ssize_t got = real(fd, buf, n);
  if (got > 0 && is_socket(fd) && dropped_udp_source(fd, NULL)) {
    errno = EAGAIN;
    return -1;
  }
  return got;
}
