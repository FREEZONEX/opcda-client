# -*- coding: utf-8 -*-
import OpenOPC
import paho.mqtt.client as mqtt
import json
import time
import signal
import sys
reload(sys)
sys.setdefaultencoding('utf-8')

OPC_SERVER = 'Kepware.KEPServerEX.V6'
OPC_HOST = '192.168.31.75'

MQTT_BROKER = '192.168.31.45'
MQTT_PORT = 1883
MQTT_TOPIC_PREFIX = 'opcda'

POLL_INTERVAL = 1

TAGS = [
    u'通道 1.设备 1.标记 1',
    u'TI2022.PV',
    u'TI2022.SV',
    u'TI2022.MV',
]

running = True

def on_exit(sig, frame):
    global running
    print("\n[*] Shutting down...")
    running = False

signal.signal(signal.SIGINT, on_exit)
signal.signal(signal.SIGTERM, on_exit)


def make_topic(tag):
    parts = tag.split('.')
    if len(parts) >= 2:
        parent = '/'.join(parts[:-1])
        leaf = parts[-1]
        topic = '%s/%s/Metric/%s' % (MQTT_TOPIC_PREFIX, parent, leaf)
    else:
        topic = '%s/Metric/%s' % (MQTT_TOPIC_PREFIX, tag)
    return topic.replace(' ', '_')


UNS_EXPORT_FILE = 'uns_import.json'

TOPIC_FIELDS = [
    {"name": "timeStamp", "type": "DATETIME", "unique": True, "systemField": True},
    {"name": "tag", "type": "LONG", "unique": True, "tbValueName": "tag", "systemField": True},
    {"name": "value", "type": "FLOAT", "index": "double_1"},
    {"name": "quality", "type": "LONG", "systemField": True},
]


def generate_uns_json(tags):
    def get_or_create(children, name, node_type="path", extra=None):
        for child in children:
            if child["name"] == name:
                return child
        node = {"type": node_type, "name": name}
        if extra:
            node.update(extra)
        if node_type == "path":
            node["children"] = []
        children.append(node)
        return node

    root_children = []
    for tag in tags:
        parts = tag.replace(' ', '_').split('.')
        if len(parts) >= 2:
            path_parts = parts[:-1]
            leaf = parts[-1]
        else:
            path_parts = []
            leaf = parts[0]

        current = root_children
        prefix_node = get_or_create(current, MQTT_TOPIC_PREFIX)
        current = prefix_node["children"]

        for p in path_parts:
            node = get_or_create(current, p)
            current = node["children"]

        metric_node = get_or_create(current, "Metric", extra={
            "displayName": "Metric",
            "dataType": "METRIC",
        })
        current = metric_node["children"]

        topic_node = {
            "type": "topic",
            "name": leaf,
            "fields": TOPIC_FIELDS,
            "dataType": "TIME_SEQUENCE_TYPE",
            "generateDashboard": "TRUE",
            "enableHistory": "TRUE",
            "mockData": "FALSE",
            "writeData": "FALSE",
            "topicType": "METRIC",
        }
        exists = False
        for child in current:
            if child["name"] == leaf:
                exists = True
                break
        if not exists:
            current.append(topic_node)

    result = {"UNS": root_children}
    with open(UNS_EXPORT_FILE, 'w') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print("[+] UNS import JSON written to %s" % UNS_EXPORT_FILE)


def run_bridge():
    global running

    print("[*] OPC DA -> MQTT Bridge")
    print("    OPC Server: %s @ %s" % (OPC_SERVER, OPC_HOST))
    print("    MQTT Broker: %s:%d" % (MQTT_BROKER, MQTT_PORT))
    print("    Tags: %d" % len(TAGS))
    print("")

    opc = None
    mqtt_client = None

    try:
        mqtt_client = mqtt.Client()
        mqtt_client.connect(MQTT_BROKER, MQTT_PORT)
        mqtt_client.loop_start()
        print("[+] MQTT connected")

        opc = OpenOPC.client()
        opc.connect(OPC_SERVER, OPC_HOST)
        print("[+] OPC DA connected")

        generate_uns_json(TAGS)

        print("[*] Publishing data every %ds (Ctrl+C to stop)..." % POLL_INTERVAL)
        print("-" * 50)

        while running:
            try:
                results = opc.read(TAGS)
            except Exception as e:
                print("[!] OPC read error: %s, reconnecting..." % str(e))
                try:
                    opc.close()
                except:
                    pass
                opc = OpenOPC.client()
                opc.connect(OPC_SERVER, OPC_HOST)
                continue

            for tag_name, value, quality, timestamp in results:
                topic = make_topic(tag_name)

                if isinstance(quality, str):
                    quality_code = 0 if quality == 'Good' else 1
                else:
                    quality_code = 0 if quality is not None and int(quality) >= 192 else 1

                if value is None:
                    out_value = 0.0
                elif isinstance(value, (int, float)):
                    out_value = float(value)
                else:
                    try:
                        out_value = float(value)
                    except (ValueError, TypeError):
                        out_value = str(value)

                payload = json.dumps({
                    'value': out_value,
                    'quality': quality_code,
                    'timestamp': str(timestamp),
                }, ensure_ascii=False)
                mqtt_client.publish(topic, payload, retain=True)

            ts = time.strftime('%H:%M:%S')
            print("[%s] Published %d tags" % (ts, len(results)))

            time.sleep(POLL_INTERVAL)

    except Exception as e:
        print("\n[!] Fatal error: %s" % str(e))
        print("    1. Is MQTT broker running? ")
        print("    2. Is OPC server reachable?")
        print("    3. Run as Administrator if DCOM access is needed.")
        sys.exit(1)

    finally:
        if opc:
            try:
                opc.close()
            except:
                pass
            print("[-] OPC DA disconnected")
        if mqtt_client:
            mqtt_client.loop_stop()
            mqtt_client.disconnect()
            print("[-] MQTT disconnected")

    print("[*] Bridge stopped.")


if __name__ == "__main__":
    run_bridge()
