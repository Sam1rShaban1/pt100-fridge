import os
import paho.mqtt.client as mqtt

BROKER = os.environ.get("MQTT_BROKER", "mosquitto")
PORT = int(os.environ.get("MQTT_PORT", "1883"))
USER = os.environ.get("MQTT_USER", "")
PASS = os.environ.get("MQTT_PASS", "")

_client = None
_cb = None
_pt_cb = None


def _on_connect(c, userdata, flags, rc, props=None):
    c.subscribe("ota/+/status")
    c.subscribe("ota/+/hello")
    c.subscribe("pt100/#")


def _on_message(c, userdata, msg):
    if msg.topic.startswith("pt100/"):
        if _pt_cb:
            _pt_cb(msg.topic, msg.payload)
    elif _cb:
        _cb(msg.topic, msg.payload)


def init(on_message, on_pt100=None):
    global _client, _cb, _pt_cb
    _cb = on_message
    _pt_cb = on_pt100
    _client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    _client.on_connect = _on_connect
    _client.on_message = _on_message
    if USER:
        _client.username_pw_set(USER, PASS)
    _client.connect_async(BROKER, PORT, 60)
    _client.loop_start()


def publish(topic, payload):
    if _client:
        _client.publish(topic, payload, qos=1)
