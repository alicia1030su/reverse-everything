#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

typedef int (*run_fn)(const unsigned char *, size_t, unsigned char *, size_t);

static int read_exact(unsigned char *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = read(STDIN_FILENO, buffer + offset, length - offset);
    if (count <= 0) return 0;
    offset += (size_t)count;
  }
  return 1;
}

static int write_exact(const unsigned char *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = write(STDOUT_FILENO, buffer + offset, length - offset);
    if (count <= 0) return 0;
    offset += (size_t)count;
  }
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  void *handle = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
  if (!handle) return 3;
  run_fn run = (run_fn)dlsym(handle, "re_run");
  if (!run) return 4;
  uint32_t length = 0;
  if (!read_exact((unsigned char *)&length, sizeof(length)) || length > 2048) return 5;
  unsigned char input[2048]; unsigned char output[4096];
  if (length && !read_exact(input, length)) return 6;
  int result = run(input, length, output, sizeof(output));
  uint32_t size = result > 0 ? (uint32_t)result : 0;
  if (!write_exact((unsigned char *)&result, sizeof(result))) return 7;
  if (size > sizeof(output)) return 8;
  if (size && !write_exact(output, size)) return 9;
  return 0;
}
