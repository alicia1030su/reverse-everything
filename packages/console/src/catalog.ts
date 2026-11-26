import type { ConsoleDevice, ConsoleDeviceId } from './types.js';

const partners: ConsoleDevice['officialDocs'] = [{ label: 'PlayStation Partners', url: 'https://partners.playstation.net/' }];
const xbox: ConsoleDevice['officialDocs'] = [{ label: 'Xbox Game Development Kit', url: 'https://learn.microsoft.com/en-us/gaming/gdk/' }];
const android: ConsoleDevice['officialDocs'] = [{ label: 'Create and run a TV app', url: 'https://developer.android.com/training/tv/start/start' }];

/** Public research catalog. Entries never imply automatic model detection or permission to bypass access controls. */
export const CONSOLE_DEVICES: readonly ConsoleDevice[] = [
  {
    id: 'ps5', manufacturer: 'Sony Interactive Entertainment', series: 'PlayStation 5', model: 'CFI-1000 family',
    officialDocs: partners,
    capabilities: ['Document device identity from public materials', 'Study legally obtained offline samples'],
    limitations: ['Retail USB-C is not a documented debugging interface', 'Console development requires an approved PlayStation program and development hardware'],
  },
  {
    id: 'ps5-slim', manufacturer: 'Sony Interactive Entertainment', series: 'PlayStation 5', model: 'CFI-2000 family',
    officialDocs: partners,
    capabilities: ['Document device identity from public materials', 'Study legally obtained offline samples'],
    limitations: ['Do not infer internal hardware revision from exterior appearance', 'No retail host debugging capability is established'],
  },
  {
    id: 'ps5-pro', manufacturer: 'Sony Interactive Entertainment', series: 'PlayStation 5', model: 'CFI-7000 family',
    officialDocs: partners,
    capabilities: ['Document device identity from public materials', 'Study legally obtained offline samples'],
    limitations: ['Do not infer internal hardware revision from exterior appearance', 'No retail host debugging capability is established'],
  },
  {
    id: 'ps4', manufacturer: 'Sony Interactive Entertainment', series: 'PlayStation 4', model: 'Consumer PlayStation 4 models',
    officialDocs: partners,
    capabilities: ['Document device identity from public materials', 'Study legally obtained offline samples'],
    limitations: ['Retail USB ports do not establish debug access', 'Console development requires an approved PlayStation program and development hardware'],
  },
  {
    id: 'xbox-series-x', manufacturer: 'Microsoft', series: 'Xbox Series X', model: 'Xbox Series X',
    officialDocs: xbox,
    capabilities: ['Document device identity from public materials', 'Study legally obtained offline samples'],
    limitations: ['Retail consoles are not development kits', 'Xbox Extensions and development hardware require an approved program'],
  },
  {
    id: 'xbox-series-s', manufacturer: 'Microsoft', series: 'Xbox Series X|S', model: 'Xbox Series S',
    officialDocs: xbox,
    capabilities: ['Document device identity from public materials', 'Study legally obtained offline samples'],
    limitations: ['Retail consoles are not development kits', 'No undocumented interface is assumed or supported'],
  },
  {
    id: 'xbox-one', manufacturer: 'Microsoft', series: 'Xbox One', model: 'Xbox One consumer models',
    officialDocs: xbox,
    capabilities: ['Document device identity from public materials', 'Study legally obtained offline samples'],
    limitations: ['Retail USB ports do not establish debug access', 'Development access depends on approved Microsoft licensing and compatible hardware'],
  },
  {
    id: 'android-tv', manufacturer: 'Varies by OEM', series: 'Android TV / Google TV', model: 'OEM television model',
    officialDocs: android,
    capabilities: ['Document documented USB debugging where the OEM enables it', 'Analyze authorized offline application and firmware samples'],
    limitations: ['ADB availability and interfaces vary by OEM, build and user authorization', 'USB debugging must be explicitly enabled and authorized by the owner'],
  },
  {
    id: 'android-tv-box', manufacturer: 'Varies by OEM', series: 'Android TV / Google TV', model: 'OEM set-top box model',
    officialDocs: android,
    capabilities: ['Document documented USB debugging where the OEM enables it', 'Analyze authorized offline application and firmware samples'],
    limitations: ['Connector shape and OS recognition do not prove ADB availability', 'Bootloader policy and update channels are OEM dependent'],
  },
  {
    id: 'other-open-embedded', manufacturer: 'Varies', series: 'Other open embedded platform', model: 'User-specified open hardware',
    officialDocs: [{ label: '无通用官方链接；必须补充具体型号的项目文档', url: '' }],
    capabilities: ['Study user-owned open hardware using its published interfaces', 'Analyze legally obtained offline samples'],
    limitations: ['No capability is assumed until model-specific documentation is supplied', 'There is no universal official documentation source for this generic category'],
  },
];

export function getConsoleDevice(id: ConsoleDeviceId): ConsoleDevice {
  const device = CONSOLE_DEVICES.find((entry) => entry.id === id);
  if (!device) throw new Error(`Unknown console device: ${String(id)}`);
  return device;
}
