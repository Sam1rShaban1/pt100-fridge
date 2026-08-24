#include "sensors.h"
#include "config.h"

void SensorArray::add(const char* id, uint8_t cs) {
  ids.push_back(id);
  drvs.push_back(new Adafruit_MAX31865(cs));
}

void SensorArray::begin(max31865_numwires_t w) {
  wires = w;
  for (auto d : drvs) d->begin(wires);
}

bool SensorArray::readAt(size_t i, float& tempC, float& resistance, uint8_t& fault) {
  if (i >= drvs.size()) return false;
  uint16_t rtd = drvs[i]->readRTD();
  fault = drvs[i]->readFault();
  resistance = ((float)rtd) * RREF / 32768.0f;
  tempC = drvs[i]->temperature(RNOMINAL, RREF);
  return true;
}
