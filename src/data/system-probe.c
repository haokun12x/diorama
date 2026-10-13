// Run: export PROBE=native; cc system-probe.c -o system-probe-test; ./system-probe-test proof
// Create directory checks intentionally require a fresh system-probe directory.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <dirent.h>
#include <sys/stat.h>
#include <time.h>
#include <wasi/api.h>
int main(int argc,char **argv) {
  if(argc!=2 || strcmp(argv[1],"proof") || strcmp(getenv("PROBE"),"native")) return 1;
  if(mkdir("system-probe",0700)) return 2;
  int fd=open("system-probe/data",O_CREAT|O_RDWR,0600); if(fd<0) return 3;
  if(write(fd,"abcd",4)!=4 || pwrite(fd,"Z",1,1)!=1 || lseek(fd,0,SEEK_SET)!=0) return 4;
  char b[5]={0}; if(read(fd,b,4)!=4 || strcmp(b,"aZcd")) return 5;
  if(ftruncate(fd,3)) return 6;
  struct stat st; if(fstat(fd,&st)||st.st_size!=3) return 7;
  if(close(fd)) return 8;
  DIR *dir=opendir("system-probe"); if(!dir) return 9;
  int found=0; struct dirent *entry; while((entry=readdir(dir))) if(!strcmp(entry->d_name,"data"))found=1;
  closedir(dir); if(!found) return 10;
  unsigned char random[32]={0}; if(__wasi_random_get(random,32)) return 11;
  int nonzero=0; for(int i=0;i<32;i++)nonzero|=random[i]; if(!nonzero) return 12;
  struct timespec t; if(clock_gettime(CLOCK_MONOTONIC,&t)) return 13;
  if(fopen("/etc/motd","w")!=NULL) return 14;
  if(rename("system-probe/data","system-probe/renamed")!= -1) return 15;
  printf("Rust/WASM services: argv env directory offsets size entropy clock permissions OK\n");
  return 0;
}
