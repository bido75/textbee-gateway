# Real Linux Bluetooth edge validation

This runbook is a manual hardware gate. Docker Desktop results do not validate Bluetooth HFP, Android behavior, a carrier, or `chan_mobile` audio.

1. Install BlueZ and an Asterisk 20 build that includes `chan_mobile` on a native Linux host.
2. Attach one supported USB Bluetooth adapter per simultaneously active phone.
3. Pair the Android phone:

```text
bluetoothctl
power on
agent on
default-agent
scan on
pair <PHONE_MAC>
trust <PHONE_MAC>
connect <PHONE_MAC>
```

4. Configure the phone MAC, adapter, and discovered HFP/RFCOMM port in `mobile.conf`.
5. Validate Asterisk:

```text
module show like mobile
mobile search
mobile show devices
```

6. Run inbound/outbound, answer, hangup, busy, no-answer, DTMF, caller-ID, two-way audio, 30-minute call, and reboot-recovery tests. Do not mark hardware validated until these pass with the intended Android, SIM, carrier, adapter, and host.

