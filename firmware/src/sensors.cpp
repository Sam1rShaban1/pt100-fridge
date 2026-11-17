#include "sensors.h"
#include "config.h"
#include "policy.h"

#include <SPI.h>
#include <math.h>

void SensorArray::add(const char* id, uint8_t cs) {
  ids.push_back(id);
  drvs.push_back(new Adafruit_MAX31865(cs));
}

void SensorArray::begin(max31865_numwires_t w) {
  wires = w;
  // The MAX31865 library uses the default SPI instance, so the pins must be
  // configured before the drivers call SPI.begin(). Getting these wrong does
  // not crash: it silently returns 0 ohm / fault readings, which is why the
  // plausibility checks below exist.
  SPI.setRX(PIN_SPI_MISO);
  SPI.setTX(PIN_SPI_MOSI);
  SPI.setSCK(PIN_SPI_SCK);
  SPI.begin();

  for (auto d : drvs) d->begin(wires);
}

bool SensorArray::readAt(size_t i, float& tempC, float& resistance, uint8_t& fault) {
  tempC = NAN;
  resistance = NAN;
  fault = 0xFF;
  if (i >= drvs.size()) return false;

  uint16_t rtd = drvs[i]->readRTD();
  fault = (uint8_t)drvs[i]->readFault();
  resistance = ((float)rtd) * RREF / 32768.0f;
  tempC = drvs[i]->temperature(RNOMINAL, RREF);

  return fw::readingValid(tempC, resistance, fault,
                          SENSOR_MIN_VALID_C, SENSOR_MAX_VALID_C,
                          SENSOR_MIN_VALID_OHM, SENSOR_MAX_VALID_OHM);
}
