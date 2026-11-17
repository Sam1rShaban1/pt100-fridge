#pragma once
#include <Adafruit_MAX31865.h>
#include <vector>

class SensorArray {
public:
  // One MAX31865 per sensor, all sharing the Pico W SPI0 bus, each with its
  // own CS pin (see PIN_SPI_* / PIN_SENSOR_CS in config.h).
  void begin(max31865_numwires_t wires = MAX31865_3WIRE);
  void add(const char* id, uint8_t cs);
  size_t count() const { return ids.size(); }
  const char* idAt(size_t i) { return ids[i]; }

  // Returns false when the reading is unusable (fault, open/short, or outside
  // the plausibility window). tempC/resistance are still filled in for logs,
  // but callers must not treat an invalid reading as a temperature.
  bool readAt(size_t i, float& tempC, float& resistance, uint8_t& fault);

private:
  std::vector<const char*> ids;
  std::vector<Adafruit_MAX31865*> drvs;
  max31865_numwires_t wires = MAX31865_3WIRE;
};
