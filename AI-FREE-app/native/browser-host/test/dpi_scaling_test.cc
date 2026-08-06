#include "../src/dpi_manager.h"

int main() {
  if (DipToPhysicalPixel(800, 96) != 800) return 1;
  if (DipToPhysicalPixel(800, 120) != 1000) return 2;
  if (DipToPhysicalPixel(800, 144) != 1200) return 3;
  if (DipToPhysicalPixel(800, 192) != 1600) return 4;
  if (DipToPhysicalPixel(41, 144) != 62) return 5;
  return 0;
}
