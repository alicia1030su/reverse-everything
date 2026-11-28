#include <stdlib.h>
int re_run(const unsigned char *input, unsigned long length, unsigned char *output, unsigned long capacity) {
  (void)input; (void)length; (void)output; (void)capacity;
  void *block = malloc(1024UL * 1024UL * 1024UL);
  if (!block) return -1;
  ((volatile char *)block)[0] = 1;
  free(block);
  return 0;
}
