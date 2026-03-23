# OPC DA to MQTT Bridge - Deployment Guide

## 1. Prerequisites (Offline Package Contents)

Before you begin, ensure you have the following files from the provided offline package:

| # | File | Purpose |
|---|------|---------|
| 1 | `python-2.7.amd64.msi` | Python 2.7 runtime |
| 2 | `pywin32-221.win-amd64-py2.7.exe` | Windows COM/DCOM support for Python |
| 3 | `OpenOPC-1.3.1.win-amd64-py2.7.exe` | OPC DA client library |
| 4 | `paho-mqtt-1.6.1.tar.gz` | MQTT client library (offline) |
| 5 | `opctest.py` | Bridge script |

> **Note:** If the script fails with a DCOM/OPC error on a machine that does NOT have KEPServerEX or any OPC software installed, you may also need to install `OPC Core Components Redistributable (x64).msi` to register `opcdaauto.dll`.

## 2. Installation Steps

### Step 1: Install Python 2.7

1. Run `python-2.7.amd64.msi`
2. **Important:** In the installation options, check **"Add python.exe to Path"**
3. Keep the default installation path: `C:\Python27\`
4. After installation, open CMD and verify:
   ```
   C:\Python27\python.exe --version
   ```
   Expected output: `Python 2.7.x`

### Step 2: Install pywin32 (DCOM Support)

1. Run `pywin32-221.win-amd64-py2.7.exe`
2. The installer will automatically detect the Python 2.7 path
3. Click "Next" through the installation

### Step 3: Install OpenOPC

1. Run `OpenOPC-1.3.1.win-amd64-py2.7.exe`
2. The installer will automatically detect the Python 2.7 path
3. Click "Next" through the installation

### Step 4: Install paho-mqtt (Offline)

1. Extract `paho-mqtt-1.6.1.tar.gz` to a folder (e.g. `C:\temp\paho-mqtt-1.6.1\`)
2. Open **Command Prompt (CMD)** and run:
   ```
   cd C:\yourpath\paho-mqtt-1.6.1
   C:\Python27\python.exe setup.py install
   ```

## 3. Configuration

Open `opctest.py` in a text editor (e.g. Notepad) and update the following settings at the top of the file:

```
OPC_SERVER = 'Kepware.KEPServerEX.V6'    # OPC DA server ProgID
OPC_HOST = '192.168.31.75'               # IP of the OPC DA server machine
MQTT_BROKER = '192.168.31.45'            # IP of the MQTT broker (Node-RED)
MQTT_PORT = 1883                         # MQTT port
POLL_INTERVAL = 1                        # Read interval in seconds
```

Update the `TAGS` list with the actual OPC DA tag names:

```
TAGS = [
    u'TI2022.PV',
    u'TI2022.SV',
    u'TI2022.MV',
    # Add more tags as needed...
]
```

## 4. Run the Bridge

1. Open **Command Prompt as Administrator** (right-click CMD > "Run as administrator")
2. Navigate to the folder containing `opctest.py`:
   ```
   cd C:\path\to\opctest
   ```
3. Run the script:
   ```
   C:\Python27\python.exe opctest.py
   ```
4. You should see output like:
   ```
   [*] OPC DA -> MQTT Bridge
       OPC Server: Kepware.KEPServerEX.V6 @ 192.168.31.75
       MQTT Broker: 192.168.31.45:1883
       Tags: 3

   [+] UNS import JSON written to uns_import.json
   [+] MQTT connected
   [+] OPC DA connected
   [*] Publishing data every 1s (Ctrl+C to stop)...
   --------------------------------------------------
   [18:30:01] Published 3 tags
   [18:30:02] Published 3 tags
   ```
5. Press `Ctrl+C` to stop the bridge gracefully

## 5. Import UNS Structure into Tier 0

1. After the script runs, a file named `uns_import.json` is generated in the same folder
2. Open the Tier 0 platform
3. Navigate to the UNS import function
4. Upload `uns_import.json`
5. The topic tree will be created automatically (e.g. `opcda/TI2022/Metric/PV`)

## 6. Troubleshooting

| Error | Solution |
|-------|----------|
| `'python' is not recognized` | Python was not added to PATH. Use the full path: `C:\Python27\python.exe` |
| `No module named OpenOPC` | OpenOPC not installed. Re-run Step 4 |
| `No module named paho` | paho-mqtt not installed. Re-run Step 5 |
| `Access denied` / DCOM error | Run CMD as **Administrator** |
| `OPC server not found` | Verify `OPC_SERVER` name and that the OPC server is running on the target machine |
| `MQTT connection refused` | Verify `MQTT_BROKER` IP and that the MQTT broker is running on port 1883 |
| Script stops unexpectedly | Check network connectivity to both OPC and MQTT servers |

## 7. Run as a Windows Service (Optional)

To keep the bridge running in the background after logoff, you can use **NSSM** (Non-Sucking Service Manager):

1. Download `nssm.exe` and place it in the script folder
2. Open CMD as Administrator and run:
   ```
   nssm install OPCDABridge "C:\Python27\python.exe" "C:\path\to\opctest.py"
   nssm start OPCDABridge
   ```
3. The bridge will now run automatically on system startup
