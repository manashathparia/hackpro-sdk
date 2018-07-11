import { delay } from 'bluebird';
import { listDriverlessDevices, DriverlessDevice as WinUsbDriverlessDevice } from 'winusb-driver-generator';

import { DriverlessDevice } from '../../source-destination/driverless';
import { Adapter } from './adapter';
import { difference } from '../../utils';

const SCAN_INTERVAL = 1000;

export class DriverlessDeviceAdapter extends Adapter {
	// Emits 'attach', 'detach' and 'ready'
	private drives: Map<string, DriverlessDevice> = new Map();
	private running = false;
	private ready = false;

	start(): void {
		this.running = true;
		this.scanLoop();
	}

	stop(): void {
		this.running = false;
		this.ready = false;
		this.drives.clear();
	}

	private async scanLoop(): Promise<void> {
		while (this.running) {
			this.scan();
			if (!this.ready) {
				this.ready = true;
				this.emit('ready');
			}
			await delay(SCAN_INTERVAL);
		}
	}

	private scan(): void {
		const drives = this.listDrives();
		if (this.running) {  // we may have been stopped while listing the drives.
			const oldDevices = new Set<string>(this.drives.keys());
			const newDevices = new Set<string>(drives.keys());
			for (const removed of difference(oldDevices, newDevices)) {
				this.emit('detach', this.drives.get(removed));
				this.drives.delete(removed);
			}
			for (const added of difference(newDevices, oldDevices)) {
				const drive = drives.get(added);
				const driverlessDevice = new DriverlessDevice(drive!);
				this.emit('attach', driverlessDevice);
				this.drives.set(added, driverlessDevice);
			}
		}
	}

	private listDrives(): Map<string, WinUsbDriverlessDevice> {
		const devices = listDriverlessDevices();
		const result = new Map<string, WinUsbDriverlessDevice>();
		for (const device of devices) {
			result.set(device.did, device);
		}
		return result;
	}
}
