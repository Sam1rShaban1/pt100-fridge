#!/usr/bin/env python3
"""
Send mock PT100 sensor readings to the local MQTT broker for testing.

Publishes to topics:  pt100/<sensor_id>
Payload:             {"temp": <float>, "resistance": <float>, "fault": 0}

Examples:
  python3 tools/mock_sensors.py
  python3 tools/mock_sensors.py --host 192.168.0.126 --count 6 --interval 2
  python3 tools/mock_sensors.py --sensors fridge_top,chiller2_a,chiller2_b

Requires: paho-mqtt (pip install paho-mqtt)
"""
import argparse
import json
import random
import signal
import sys
import time

try:
    import paho.mqtt.client as mqtt
except Exception:
    print("Missing dependency: paho-mqtt. Install with: pip install paho-mqtt", file=sys.stderr)
    sys.exit(1)


def resistance_for_temp(temp_c: float) -> float:
    """Approximate PT100 resistance (Callendar-Van Dusen, simplified) for a realistic payload."""
    # R(T) ~ R0 * (1 + A*T + B*T^2), A=3.9083e-3, B=-5.775e-7, R0=100
    r0 = 100.0
    a = 3.9083e-3
    b = -5.775e-7
    return r0 * (1.0 + a * temp_c + b * (temp_c * temp_c))


def make_sensors(n, explicit):
    if explicit:
        ids = [s.strip() for s in explicit.split(",") if s.strip()]
    else:
        ids = [f"mock_sensor_{i}" for i in range(1, n + 1)]
    # start each sensor at a slightly different baseline in a fridge-like range
    sensors = []
    for i, sid in enumerate(ids):
        base = 2.0 + (i % 4) * 1.2 + random.uniform(-0.3, 0.3)
        sensors.append({"id": sid, "temp": base, "base": base})
    return sensors


def main():
    ap = argparse.ArgumentParser(description="Publish mock PT100 sensor data over MQTT.")
    ap.add_argument("--host", default="192.168.0.126", help="MQTT broker host (default: 192.168.0.126)")
    ap.add_argument("--port", type=int, default=1883, help="MQTT broker port (default: 1883)")
    ap.add_argument("--user", default="fridge-001", help="MQTT username (default: fridge-001)")
    ap.add_argument("--password", default="localdev-pass", help="MQTT password (default: localdev-pass)")
    ap.add_argument("--count", type=int, default=6, help="Number of mock sensors if --sensors not given (default: 6)")
    ap.add_argument("--sensors", default="", help="Comma-separated sensor IDs (overrides --count)")
    ap.add_argument("--interval", type=float, default=2.0, help="Publish interval in seconds (default: 2.0)")
    ap.add_argument("--min-temp", type=float, default=-2.0, help="Lower temp bound for drift (default: -2.0)")
    ap.add_argument("--max-temp", type=float, default=8.0, help="Upper temp bound for drift (default: 8.0)")
    args = ap.parse_args()

    sensors = make_sensors(max(1, args.count), args.sensors)
    if not sensors:
        print("No sensors to publish.", file=sys.stderr)
        sys.exit(1)

    # paho-mqtt v1/v2 compatibility
    try:
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    except Exception:
        client = mqtt.Client()
    if args.user:
        client.username_pw_set(args.user, args.password)

    print(f"Connecting to mqtt://{args.host}:{args.port} as '{args.user}' ...")
    client.connect(args.host, args.port, keepalive=60)
    client.loop_start()

    running = True

    def stop(*_):
        nonlocal running
        running = False

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    print(f"Publishing {len(sensors)} sensors every {args.interval}s: {', '.join(s['id'] for s in sensors)}")
    print("Press Ctrl+C to stop.\n")

    try:
        while running:
            for s in sensors:
                # gentle random walk around each sensor's baseline, clamped to bounds
                drift = (s["base"] - s["temp"]) * 0.05
                s["temp"] += drift + random.uniform(-0.15, 0.15)
                s["temp"] = max(args.min_temp, min(args.max_temp, s["temp"]))
                payload = {
                    "temp": round(s["temp"], 2),
                    "resistance": round(resistance_for_temp(s["temp"]), 2),
                    "fault": 0,
                }
                topic = f"pt100/{s['id']}"
                client.publish(topic, json.dumps(payload), qos=0)
                print(f"{topic}  temp={payload['temp']:>6.2f}°C  R={payload['resistance']:>7.2f}Ω")
            print("-" * 50)
            # sleep in small steps so Ctrl+C is responsive
            end = time.time() + args.interval
            while running and time.time() < end:
                time.sleep(0.1)
    finally:
        client.loop_stop()
        client.disconnect()
        print("Stopped.")


if __name__ == "__main__":
    main()
