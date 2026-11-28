#include <dlfcn.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

typedef int (*run_fn)(const unsigned char *, size_t, unsigned char *, size_t);

static uint32_t state = 0x9e3779b9u;
static unsigned char next_byte(void) {
  state ^= state << 13; state ^= state >> 17; state ^= state << 5;
  return (unsigned char)state;
}

static int read_timeout(int fd, unsigned char *buffer, size_t length, int timeout_ms) {
  size_t offset = 0;
  while (offset < length) {
    struct pollfd descriptor = { fd, POLLIN, 0 };
    int ready = poll(&descriptor, 1, timeout_ms);
    if (ready <= 0) return 0;
    ssize_t count = read(fd, buffer + offset, length - offset);
    if (count <= 0) return 0;
    offset += (size_t)count;
  }
  return 1;
}

static int run_candidate(const char *worker, const char *candidate, const unsigned char *input, size_t length, unsigned char *actual, int *actual_size) {
  int input_pipe[2]; int output_pipe[2];
  if (pipe(input_pipe) != 0 || pipe(output_pipe) != 0) return 0;
  pid_t child = fork();
  if (child < 0) return 0;
  if (child == 0) {
    dup2(input_pipe[0], STDIN_FILENO); dup2(output_pipe[1], STDOUT_FILENO);
    close(input_pipe[0]); close(input_pipe[1]); close(output_pipe[0]); close(output_pipe[1]);
    execl(worker, worker, candidate, (char *)NULL);
    _exit(127);
  }
  close(input_pipe[0]); close(output_pipe[1]);
  uint32_t wire_length = (uint32_t)length;
  int ok = write(input_pipe[1], &wire_length, sizeof(wire_length)) == (ssize_t)sizeof(wire_length);
  if (ok && length) ok = write(input_pipe[1], input, length) == (ssize_t)length;
  close(input_pipe[1]);
  int result = 0;
  if (ok) ok = read_timeout(output_pipe[0], (unsigned char *)&result, sizeof(result), 5000);
  int size = result > 0 ? result : 0;
  if (ok && size > 4096) ok = 0;
  if (ok && size) ok = read_timeout(output_pipe[0], actual, (size_t)size, 5000);
  unsigned char extra = 0;
  if (ok) {
    struct pollfd descriptor = { output_pipe[0], POLLIN, 0 };
    int ready = poll(&descriptor, 1, 100);
    if (ready > 0) {
      ssize_t extra_count = read(output_pipe[0], &extra, 1);
      if (extra_count != 0) ok = 0;
    } else if (ready < 0) ok = 0;
  }
  close(output_pipe[0]);
  int status = 0; pid_t waited = 0;
  for (int attempt = 0; attempt < 50; attempt++) {
    waited = waitpid(child, &status, WNOHANG);
    if (waited == child || (waited < 0 && errno != EINTR)) break;
    poll(NULL, 0, 100);
  }
  if (waited != child) { kill(child, SIGKILL); waitpid(child, &status, 0); ok = 0; }
  *actual_size = result;
  return ok && WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

int main(int argc, char **argv) {
  if (argc != 4) { fprintf(stderr, "usage: hidden_runner <original.so> <candidate.so> <candidate_worker>\n"); return 2; }
  signal(SIGPIPE, SIG_IGN);
  void *original = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
  if (!original) { fprintf(stderr, "original dlopen: %s\n", dlerror()); return 2; }
  run_fn original_run = (run_fn)dlsym(original, "re_run");
  if (!original_run) { fprintf(stderr, "missing original re_run export\n"); return 2; }

  unsigned char input[2048]; unsigned char expected[4096]; unsigned char actual[4096];
  int tests = 0;
  for (int round = 0; round < 80; round++) {
    size_t length = round < 20 ? (size_t)round : (size_t)(next_byte() | (next_byte() << 8));
    if (length > sizeof(input)) length = sizeof(input);
    for (size_t i = 0; i < length; i++) input[i] = round < 20 ? (unsigned char)(i + round) : next_byte();
    memset(expected, 0xa5, sizeof(expected)); memset(actual, 0x5a, sizeof(actual));
    int expected_size = original_run(input, length, expected, sizeof(expected));
    int actual_size = 0;
    if (!run_candidate(argv[3], argv[2], input, length, actual, &actual_size)) {
      fprintf(stderr, "candidate protocol failure round=%d length=%zu\n", round, length);
      return 1;
    }
    if (expected_size != actual_size || (expected_size > 0 && memcmp(expected, actual, (size_t)expected_size) != 0)) {
      fprintf(stderr, "mismatch round=%d length=%zu expected=%d actual=%d\n", round, length, expected_size, actual_size);
      return 1;
    }
    tests++;
  }
  printf("PASS %d\n", tests);
  dlclose(original);
  return 0;
}
