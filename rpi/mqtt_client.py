"""Thin MQTT wrapper (paho) matching the firmware's publish/subscribe contract.

On connect it (re)subscribes to the OTA topics and emits an on_connect callback
so the app can send hello. Incoming messages are dispatched to on_message.
"""

import paho.mqtt.client as mqtt


class MQTTClient:
    def __init__(self, broker, port, user=None, password=None, tls_ca=None,
                 subscriptions=None, on_connect=None, on_message=None):
        self.broker = broker
        self.port = port
        self.subscriptions = subscriptions or []
        self.on_connect = on_connect
        self.on_message = on_message
        self.c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        if tls_ca:
            self.c.tls_set(ca_certs=tls_ca)
        if user:
            self.c.username_pw_set(user, password)
        self.c.on_connect = self._on_connect
        self.c.on_message = self._on_message

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        for topic in self.subscriptions:
            client.subscribe(topic)
        if self.on_connect:
            self.on_connect()

    def _on_message(self, client, userdata, msg):
        if self.on_message:
            self.on_message(msg.topic, msg.payload)

    def connect(self):
        self.c.connect(self.broker, self.port, keepalive=60)
        self.c.loop_start()

    def is_connected(self):
        return self.c.is_connected()

    def publish(self, topic, payload, retain=False):
        try:
            return self.c.publish(topic, payload, retain=retain)
        except Exception:
            try:
                self.c.reconnect()
                return self.c.publish(topic, payload, retain=retain)
            except Exception:
                return None

    def loop(self, timeout=1.0):
        self.c.loop(timeout)
