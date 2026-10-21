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
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
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
static const char *arm_path;
static int armed;

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

static int tcp_socket(int fd) {
  int type = 0;
  socklen_t len = sizeof(type);
  if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &len) != 0) return 0;
  return type == SOCK_STREAM;
}

static void pace(int fd, size_t n) {
  if (!bucket || n == 0 || rate_bps < 1) return;
  if (arm_path && !armed) {
    if (access(arm_path, F_OK) != 0) return;
    armed = 1;
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
  arm_path = getenv("UPLINK_ARM");
  if (arm_path && !arm_path[0]) arm_path = NULL;
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
  if (is_socket(fd)) pace(fd, n);
  return real(fd, buf, n, flags);
}

ssize_t sendto(int fd, const void *buf, size_t n, int flags, const struct sockaddr *addr, socklen_t len) {
  static ssize_t (*real)(int, const void *, size_t, int, const struct sockaddr *, socklen_t);
  if (!real) real = dlsym(RTLD_NEXT, "sendto");
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
  if (is_socket(fd)) pace(fd, n);
  return real(fd, msgvec, vlen, flags);
}

ssize_t write(int fd, const void *buf, size_t n) {
  static ssize_t (*real)(int, const void *, size_t);
  if (!real) real = dlsym(RTLD_NEXT, "write");
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
  if (is_socket(fd)) pace(fd, n);
  return real(fd, iov, iovcnt);
}
