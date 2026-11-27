#include <pthread.h>
#include <stdio.h>

static int shared_counter = 40;

static void *worker(void *argument) {
    (void)argument;
    shared_counter += 2;
    return NULL;
}

int main(int argc, char **argv) {
    pthread_t thread;
    int adjustment = argc > 1 ? 1 : 0;
    if (pthread_create(&thread, NULL, worker, NULL) != 0) return 2;
    shared_counter += adjustment;
    if (pthread_join(thread, NULL) != 0) return 3;
    printf("dynamic-v009-counter=%d\n", shared_counter);
    return shared_counter == 42 ? 0 : 1;
}
