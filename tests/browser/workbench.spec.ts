import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
test('workspace, project creation, navigation and archive preserve local project', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '让创意，成为可以玩的游戏。' })).toBeVisible();
  await page.getByRole('button', { name: '＋ 创建游戏项目' }).click();
  await page.getByLabel('项目名称').fill('界面回归 · ' + Date.now());
  await page
    .getByLabel('游戏创意')
    .fill('自动化界面验证项目，仅检查工作台的创建、导航与归档，不执行模型任务。');
  await page.getByRole('button', { name: '创建项目 →' }).click();
  await expect(page.getByRole('heading', { name: /界面回归/ })).toBeVisible();
  await page.getByRole('button', { name: '画布视图' }).click();
  await expect(page.getByRole('heading', { name: '产物画布' })).toBeVisible();
  await page.getByRole('button', { name: '记忆与知识' }).click();
  await expect(page.getByRole('heading', { name: '知识审核与版本' })).toBeVisible();
  await page.getByRole('button', { name: '归档项目', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复项目', exact: true })).toBeVisible();
  await page.locator('.breadcrumb').getByRole('link', { name: '工作空间' }).click();
  await expect(page.getByRole('heading', { name: '最近项目' })).toBeVisible();
});
test('isolated fixture renders classic and canvas using same artifacts', async ({ page, request }) => {
  const projects = await (await request.get('/api/projects')).json();
  const project = projects.find((p: any) => p.name === '双视图测试夹具');
  await page.goto('/#' + project.id);
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '制作路径', exact: true })).toBeVisible();
  mkdirSync('.local/screenshots', { recursive: true });
  await page.screenshot({ path: '.local/screenshots/fixture-classic.png', fullPage: true });
  const detail = await (await request.get('/api/projects/' + project.id)).json();
  await page.getByRole('button', { name: '画布视图' }).click();
  expect(detail.artifacts.length).toBeGreaterThan(16);
  await expect(page.locator('.canvas-node')).toHaveCount(detail.artifacts.length);
  await expect(page.locator('.canvas-node').filter({ hasText: '测试制作计划' })).toHaveCount(1);
  expect(await page.locator('.canvas-scroll').evaluate((el) => el.scrollHeight)).toBeGreaterThan(760);
  await page.screenshot({ path: '.local/screenshots/fixture-canvas.png', fullPage: true });
  await page.getByRole('button', { name: '运营与实验' }).click();
  await expect(page.getByRole('button', { name: '启动试玩分析' })).toBeVisible();
});

test('knowledge draft and review preserve explicit approval and report remains readable', async ({
  page,
  request,
}) => {
  const project = await (
    await request.post('/api/projects', {
      data: { name: 'Knowledge UI fixture', idea: 'Synthetic knowledge review test' },
    })
  ).json();
  await page.goto('/#' + project.id);
  await page.getByRole('button', { name: '记忆与知识' }).click();
  await page.getByText('提出知识新增、修订或退役', { exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill('Synthetic observation');
  await page.getByLabel('结论或退役理由').fill('Only a deterministic UI test observation');
  await page.getByLabel('新增证据（每行一个事件、实验或文件引用）').fill('synthetic-browser-fixture');
  await page.getByRole('button', { name: '提交到待审核区' }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic observation' })).toBeVisible();
  await expect(page.getByRole('button', { name: '批准知识' })).toBeVisible();
  await page.getByRole('button', { name: '批准知识' }).click();
  await expect(page.getByText('知识版本已生效', { exact: true })).toBeVisible();
  const detail = await (await request.get('/api/projects/' + project.id)).json();
  expect(detail.knowledge[0].status).toBe('approved');
  await page.getByRole('button', { name: '执行记录' }).click();
  await expect(page.getByRole('heading', { name: '任务执行与用量' })).toBeVisible();
});
test('workspace supports a narrow viewport without body overflow', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 980 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '最近项目' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
