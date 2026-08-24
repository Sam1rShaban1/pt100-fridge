"""Minimal MAX31865 RTD-to-digital driver for the Raspberry Pi via spidev.

Mirrors the register-level protocol used by the ESP32 firmware's sensors.cpp
(reads Config/RTD MSB/RTD LSB/Fault registers, applies Callendar-Van Dusen).
No external RTD library required.

If spidev is unavailable (e.g. not on a Pi), use SimSensor instead.
"""

import math
import time

try:
    import spidev
    _HAVE_SPIDEV = True
except ImportError:  # running off-Pi (import only)
    spidev = None
    _HAVE_SPIDEV = False

RTD_A = 3.9083e-3
RTD_B = -5.775e-7


class MAX31865:
    """Real MAX31865 over /dev/spidev<bus>.<cs>."""

    def __init__(self, bus=0, cs=0, wires=3, rtd_nominal=100.0, ref_resistor=430.0):
        if not _HAVE_SPIDEV:
            raise RuntimeError("spidev not available")
        self.rtd_nominal = rtd_nominal
        self.ref_resistor = ref_resistor
        self.spi = spidev.SpiDev()
        self.spi.open(bus, cs)
        self.spi.max_speed_hz = 1_000_000
        self.spi.mode = 1  # SPI_MODE1 (CPOL=0, CPHA=1)
        self.spi.bits_per_word = 8
        cfg = 0x80 | 0x40  # Vbias on + auto-conversion
        if wires == 3:
            cfg |= 0x10
        self._write(0x00, cfg)

    def _read(self, addr):
        rx = self.spi.xfer2([(addr << 1) | 0x80, 0x00])
        return rx[1]

    def _write(self, addr, val):
        self.spi.xfer2([(addr << 1) & 0x7F, val & 0xFF])

    def read_rtd(self):
        hi = self._read(0x01)
        lo = self._read(0x02)
        return ((hi << 8) | lo) >> 1

    def read_fault(self):
        return self._read(0x07)

    def resistance(self):
        return self.read_rtd() / 32768.0 * self.ref_resistor

    def temperature(self):
        rt = self.resistance()
        z1 = -RTD_A
        z2 = RTD_A * RTD_A - (4 * RTD_B)
        z3 = (4 * RTD_B) / self.rtd_nominal
        z4 = 2 * RTD_B
        t = z2 + z3 * rt
        t = rt * math.sqrt(z1 + t)
        t = t + z4
        t = math.sqrt(t)
        t = t - RTD_A
        t = t / RTD_B
        return round(t, 2)


class SimSensor:
    """Drop-in simulated sensor when no hardware / spidev is present."""

    def __init__(self, base=4.0):
        self.base = base
        self.rtd_nominal = 100.0
        self.ref_resistor = 430.0
        self._offset = (hash(str(base)) % 100) / 10.0

    def read_rtd(self):
        return int(self.resistance() / self.ref_resistor * 32768)

    def read_fault(self):
        return 0

    def resistance(self):
        t = self.temperature()
        return self.rtd_nominal * (1.0 + RTD_A * t + RTD_B * t * t)

    def temperature(self):
        return round(self.base + self._offset + (time.time() % 12) * 0.25, 2)
