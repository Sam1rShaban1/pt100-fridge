#!/usr/bin/env bash
# Regenerate the MQTT CA + server certificate.
# After running this you MUST copy the new ca.crt contents into
# firmware/src/certs.h (MQTT_ROOT_CA) so the ESP32 still trusts the broker.
set -e
cd "$(dirname "$0")/certs"

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout ca.key -out ca.crt -days 3650 \
  -subj "/CN=pt100-ota-ca"

openssl req -newkey rsa:2048 -nodes \
  -keyout server.key -out server.csr \
  -subj "/CN=mqtt.example.com"

openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 3650 \
  -extfile <(printf "subjectAltName=DNS:mqtt.example.com")

rm -f server.csr ca.srl
echo "Wrote ca.crt / server.crt / server.key"
