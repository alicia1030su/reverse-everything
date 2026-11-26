import { expect, test, type Page } from '@playwright/test';
import { onboardingKey, openWorkspace } from './workspace';

const themeKey = 'reverse-everything:theme';

async function createFileProject(page: Page, name: string, fileName = 'sample.json'): Promise<string> {
  await page.request.get('/api/session');
  const response = await page.request.post('/api/projects', {
    data: { name, kind: 'software', authorizationConfirmed: true },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const project = await response.json() as { id: string };
  const upload = await page.request.post(`/api/projects/${project.id}/uploads`, {
    multipart: {
      file: {
        name: fileName,
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({ name: 'v004-web-fixture', version: 1 })),
      },
    },
  });
  expect(upload.ok(), await upload.text()).toBe(true);
  return project.id;
}

function emptyUsbPcap(): Buffer {
  const capture = Buffer.alloc(24);
  capture.writeUInt32LE(0xa1b2c3d4, 0);
  capture.writeUInt16LE(2, 4);
  capture.writeUInt16LE(4, 6);
  capture.writeUInt32LE(65_535, 16);
  capture.writeUInt32LE(220, 20);
  return capture;
}

test('new project exposes nine explicit analysis entry points with input, output and boundaries', async ({ page }) => {
  await openWorkspace(page);
  await expect(page.locator('button[aria-pressed]')).toHaveCount(9);
  const entries = [
    ['网页分析', '输出：网页快照'],
    ['软件分析', '输出：格式'],
    ['Android 分析', '输出：Manifest'],
    ['游戏复活', '输出：协议'],
    ['网络协议分析', '输出：端点'],
    ['安全分析', '输出：被动检查'],
    ['USB 硬件分析', '输出：设备'],
    ['固件分析', '输出：固件身份'],
    ['开发板记录分析', '输出：开发板'],
  ];
  for (const [name, output] of entries) {
    const entry = page.getByRole('button', { name: new RegExp(name) });
    await expect(entry).toBeVisible();
    await expect(entry).toContainText(output);
    await expect(entry).toContainText('边界：');
  }

  await expect(page.getByRole('button', { name: /Ghidra 静态分析/ })).toHaveCount(0);

  await page.getByRole('button', { name: /软件分析/ }).click();
  await expect(page.getByRole('radio', { name: /基础静态分析/ })).toBeChecked();
  await page.getByRole('radio', { name: /Ghidra 静态分析/ }).check();
  await expect(page.getByLabel('Ghidra 二进制文件')).toBeAttached();
  await expect(page.getByText('边界：需要本机 Ghidra headless；不运行目标程序。')).toBeVisible();
  await page.getByRole('radio', { name: /基础静态分析/ }).check();
  await expect(page.getByLabel('软件样本文件')).toBeAttached();

  await page.getByRole('button', { name: /安全分析/ }).click();
  await expect(page.getByRole('radio', { name: '目标 URL' })).toBeChecked();
  await expect(page.getByRole('radio', { name: '离线上传文件' })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: '目标 URL' })).toBeVisible();

  await page.getByRole('button', { name: /USB 硬件分析/ }).click();
  await expect(page.getByRole('button', { name: '浏览本地设备' })).toBeVisible();
  await expect(page.getByRole('radio', { name: '离线上传文件' })).toBeChecked();
  await expect(page.getByLabel('USB 记录或描述符文件')).toBeAttached();

  await page.getByRole('button', { name: /开发板记录分析/ }).click();
  await expect(page.getByLabel('开发板离线记录')).toBeAttached();
  await expect(page.getByText(/不打开设备或串口、不抓键盘、不刷写固件/).first()).toBeVisible();
  await expect(page.getByText(/不宣称特定开发板兼容性/).first()).toBeVisible();

  await page.getByRole('button', { name: /固件分析/ }).click();
  await expect(page.getByLabel('固件镜像文件')).toBeAttached();
  await page.screenshot({ path: 'test-results/evidence/v004-new-project.png', fullPage: true });
});

test('hardware lab uses real local enumeration and creates an offline USB task', async ({ page }) => {
  await openWorkspace(page, '/hardware');
  await expect(page.getByRole('heading', { name: '硬件实验室' })).toBeVisible();
  await expect(page.getByText('不会打开设备句柄或串口，也不会执行固件。')).toBeVisible();
  await expect(page.getByText('串口仅列出，不打开。')).toBeVisible();

  const doctorResponse = await page.request.get('/api/hardware/doctor');
  expect(doctorResponse.ok(), await doctorResponse.text()).toBe(true);
  const doctor = await doctorResponse.json() as { status: string; deviceCount: number };
  await expect(page.getByTestId('hardware-doctor-status')).toHaveText(doctor.status);
  await expect(page.getByTestId('hardware-device-count')).toHaveText(String(doctor.deviceCount));

  const devicesResponse = await page.request.get('/api/hardware/devices');
  expect(devicesResponse.ok(), await devicesResponse.text()).toBe(true);
  const enumeration = await devicesResponse.json() as { devices: { identity: { stableKey: string } }[] };
  if (enumeration.devices.length === 0) {
    await expect(page.getByText('未枚举到 USB 设备')).toBeVisible();
  } else {
    await expect(page.getByTestId('hardware-device-list').getByRole('button')).toHaveCount(
      Math.min(enumeration.devices.length, 25),
    );
  }
  await page.screenshot({ path: 'test-results/evidence/v004-hardware.png', fullPage: true });

  await page.getByLabel('任务项目名称').fill(`v004 USB 离线 ${Date.now()}`);
  await page.getByLabel('USB 记录或描述符文件').setInputFiles({
    name: 'empty-usb.pcap',
    mimeType: 'application/vnd.tcpdump.pcap',
    buffer: emptyUsbPcap(),
  });
  await page.getByLabel('确认已获得硬件分析授权').check();
  await page.getByRole('button', { name: '上传记录并创建离线任务' }).click();
  await expect(page).toHaveURL(/\/tasks\/[^/]+$/);
  await expect.poll(async () => {
    const response = await page.request.get(`/api/tasks/${page.url().split('/').pop()}`);
    const task = await response.json() as { status: string; error?: string };
    return `${task.status}:${task.error ?? ''}`;
  }, { timeout: 90_000, intervals: [500, 1000, 2000] }).toMatch(/^COMPLETED:/);
});

test('first-run guide allows skipping AI without blocking basic analysis', async ({ page }) => {
  await page.goto('/new');
  await expect(page.getByRole('dialog', { name: '首次使用引导' })).toBeVisible();
  await page.getByLabel('确认已阅读并理解安全提示').check();
  await page.getByRole('button', { name: '下一步：选择场景' }).click();
  await page.getByRole('button', { name: '网页分析', exact: true }).click();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByText('环境检测')).toBeVisible();
  await page.screenshot({ path: 'test-results/evidence/v004-onboarding.png', fullPage: true });
  await page.getByRole('button', { name: '下一步：可选 AI' }).click();
  await page.getByRole('button', { name: '跳过 AI，继续' }).click();
  await expect(page.getByText('演示与创建任务')).toBeVisible();
  await page.getByRole('button', { name: '完成引导，开始分析' }).click();
  await expect(page.getByRole('dialog', { name: '首次使用引导' })).toBeHidden();
  const completion = await page.evaluate(key => JSON.parse(window.localStorage.getItem(key) ?? '{}'), onboardingKey);
  expect(completion.completed).toBe(true);
  await expect(page.getByRole('heading', { name: '创建逆向项目' })).toBeVisible();
});

test('mobile navigation drawer reaches project creation and hardware lab', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openWorkspace(page, '/');
  await page.getByRole('button', { name: '打开导航' }).click();
  await expect(page.getByRole('dialog', { name: '移动导航' })).toBeVisible();
  await page.getByRole('dialog', { name: '移动导航' }).getByRole('link', { name: '创建项目' }).click();
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByRole('dialog', { name: '移动导航' })).toBeHidden();
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('dialog', { name: '移动导航' }).getByRole('link', { name: '硬件实验室' }).click();
  await expect(page).toHaveURL(/\/hardware$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/evidence/v004-mobile-hardware.png', fullPage: true });
});

test('theme switch persists a light theme and can restore dark', async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole('button', { name: '切换到浅色主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(key => window.localStorage.getItem(key), themeKey)).toBe('light');
  await page.screenshot({ path: 'test-results/evidence/v004-light-theme.png', fullPage: true });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: '切换到深色主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('dashboard labels all adapters and operations remains reachable', async ({ page }) => {
  await openWorkspace(page, '/');
  for (const label of ['网络协议', 'Android APK', 'Ghidra', 'USB 硬件', '固件']) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await page.getByRole('link', { name: '系统运维' }).click();
  await expect(page).toHaveURL(/\/operations\/system$/);
  await expect(page.getByRole('heading', { name: '系统状态' })).toBeVisible();
});

test('existing project can create another task from its uploaded input', async ({ page }) => {
  const projectId = await createFileProject(page, `v004 再次分析 ${Date.now()}`);
  await openWorkspace(page, `/projects/${projectId}`);
  await page.getByRole('button', { name: '基于现有输入新建任务' }).click();
  await expect(page).toHaveURL(/\/tasks\/[^/]+$/);
  const taskId = page.url().split('/').pop()!;
  const response = await page.request.get(`/api/tasks/${taskId}`);
  const task = await response.json() as { adapter: string; projectId: string };
  expect(task.projectId).toBe(projectId);
  expect(task.adapter).toBe('file');
});
