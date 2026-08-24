#pragma once
#include <Adafruit_MAX31865.h>
#include <vector>

class SensorArray {
public:
  // One MAX31865 per sensor, all sharing the ESP32 VSPI bus (SCLK=18, MOSI=23, MISO=19),
  // each with its own CS pin.
  void begin(max31865_numwires_t wires = MAX31865_3WIRE);
  void add(const char* id, uint8_t cs);
  size_t count() const { return ids.size(); }
  const char* idAt(size_t i) const { return ids[i]; }
  bool readAt(size_t i, float& tempC, float& resistance, uint8_t& fault);

private:
  std::vector<const char*> ids;
  std::vector<Adafruit_MAX31865*> drvs;
  max31865_numwires_t wires = MAX31865_3WIRE;
};
