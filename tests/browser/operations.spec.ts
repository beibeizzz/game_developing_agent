import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

async function fixture(page: Page, request: APIRequestContext, customize?: (snapshot: any) => void) {
  const projects = await (await request.get('/api/projects')).json();
  const project = projects.find((p: any) => p.name === '运营交互测试夹具');
  const snapshot = await (await request.get('/api/projects/' + project.id)).json();
  customize?.(snapshot);
  await page.route('**/api/projects/' + project.id, (route) => route.fulfill({ json: snapshot }));
  await page.goto('/#' + project.id);
  await page.getByRole('button', { name: /运营与实验/ }).click();
  return { project, snapshot };
}

test('operations separates proposal kinds, preserves history and explains approval gates', async ({
  page,
  request,
}) => {
  await fixture(page, request);
  await expect(page.getByRole('heading', { name: '当前游戏迭代提案' })).toBeVisible();
  await expect(page.locator('.proposal-card')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: '延长安全时间方案' })).toBeVisible();
  expect((await page.locator('.proposal-summary').innerText()).length).toBeLessThan(300);
  await page.getByRole('button', { name: '展开完整摘要' }).click();
  expect((await page.locator('.proposal-summary').innerText()).length).toBeGreaterThan(500);
  await page.getByRole('button', { name: '收起摘要' }).click();
  await expect(page.getByRole('button', { name: '预登记并执行修改', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '查看历史方案（1）' }).click();
  const old = page.locator('.proposal-card').filter({ hasText: '旧版安全时间方案' });
  await expect(old).toBeVisible();
  await expect(old.getByRole('button', { name: '预登记并执行修改' })).toBeDisabled();
  await page
    .getByRole('group', { name: '运营工作区' })
    .getByRole('button', { name: /制作新游戏/ })
    .click();
  await expect(page.getByRole('heading', { name: '新游戏立项方案' })).toBeVisible();
  await expect(page.getByRole('button', { name: '创建并制作新游戏', exact: true })).toBeDisabled();
  await expect(page.getByText('审核通过后即可执行。', { exact: true })).toBeVisible();
  await expect(page.getByText('执行后：创建独立项目，并进入调研、策划与制作流程。')).toBeVisible();
  await page.getByRole('button', { name: '准备新游戏立项' }).click();
  await expect(page.getByLabel('任务类型')).toHaveValue('ideation');
  await expect(page.getByLabel('任务要求', { exact: true })).toBeFocused();
});

test('approved proposal and ideation call distinct execution routes', async ({ page, request }) => {
  const { project, snapshot } = await fixture(page, request);
  const proposal = snapshot.artifacts.filter((a: any) => a.role === 'proposal').at(-1);
  const idea = snapshot.artifacts.find((a: any) => a.role === 'ideation');
  const calls: any[] = [];
  await page.route('**/api/projects/' + project.id + '/execute-proposal', async (route) => {
    calls.push({ action: 'proposal', body: route.request().postDataJSON() });
    await route.fulfill({ json: { id: 'mock-iteration-task' } });
  });
  await page.getByRole('button', { name: '预登记并执行修改', exact: true }).click();
  await expect.poll(() => calls).toEqual([{ action: 'proposal', body: { proposalId: proposal.id } }]);
  snapshot.approvals.find((a: any) => a.artifactId === idea.id).status = 'approved';
  const destination = await (
    await request.post('/api/projects', {
      data: { name: '模拟立项目标项目', idea: 'UI navigation fixture only' },
    })
  ).json();
  await page.route('**/api/projects/' + project.id + '/execute-ideation', async (route) => {
    calls.push({ action: 'ideation', body: route.request().postDataJSON() });
    await route.fulfill({ json: { newProjectId: destination.id } });
  });
  await page.reload();
  await page.getByRole('button', { name: /运营与实验/ }).click();
  await page
    .getByRole('group', { name: '运营工作区' })
    .getByRole('button', { name: /制作新游戏/ })
    .click();
  await page.getByRole('button', { name: '创建并制作新游戏', exact: true }).click();
  await expect.poll(() => calls.at(-1)).toEqual({ action: 'ideation', body: { artifactId: idea.id } });
  await expect(page).toHaveURL(new RegExp('#' + destination.id + '$'));
});

test('experiment evidence and guardrail inputs remain independent', async ({ page, request }) => {
  await fixture(page, request);
  await page
    .getByRole('group', { name: '运营工作区' })
    .getByRole('button', { name: /实验与结算/ })
    .click();
  const human = page.locator('.experiment-card').filter({ hasText: '人工试玩' });
  const script = page.locator('.experiment-card').filter({ hasText: '脚本测评' });
  await human
    .getByRole('textbox', { name: '结算依据', exact: true })
    .fill('人工：键盘实测一局，记录对应构建。');
  await human.getByLabel('护栏检查通过', { exact: true }).uncheck();
  await expect(script.getByRole('textbox', { name: '结算依据', exact: true })).toHaveValue('');
  await expect(script.getByLabel('护栏检查通过', { exact: true })).toBeChecked();
  await script.getByRole('textbox', { name: '结算依据', exact: true }).fill('脚本：固定 Seed，14 项通过。');
  let sent: any;
  await page.route('**/api/experiments/ui-experiment-human/settle', async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ json: { pendingReason: '模拟结算结果已收到' } });
  });
  await human.getByRole('button', { name: '执行到期结算' }).click();
  await expect
    .poll(() => sent)
    .toEqual({ guardrailsPassed: false, evidence: '人工：键盘实测一局，记录对应构建。' });
  await expect(script.getByRole('textbox', { name: '结算依据', exact: true })).toHaveValue(
    '脚本：固定 Seed，14 项通过。',
  );
});

test('mobile project navigation and operation panels fit a phone viewport', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, request);
  await expect(page.getByRole('heading', { name: '当前游戏迭代提案' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page
    .getByRole('group', { name: '运营工作区' })
    .getByRole('button', { name: /制作新游戏/ })
    .click();
  await expect(page.getByRole('button', { name: '创建并制作新游戏', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('existing-game defaults and error details stay understandable across polling', async ({
  page,
  request,
}) => {
  const error =
    '模型结构化产物校验失败：' +
    JSON.stringify({ evidence: Array(60).fill('Expected string, received number') });
  await fixture(page, request, (snapshot) => {
    snapshot.builds = [{ id: 'ui-baseline-build', preview: 'http://127.0.0.1:18808/test-only' }];
    snapshot.tasks.at(-1).status = 'failed';
    snapshot.tasks.at(-1).error = error;
  });
  await expect(page.getByText(error, { exact: true })).toBeHidden();
  await page.getByText('查看错误详情', { exact: true }).click();
  await expect(page.getByText(error, { exact: true })).toBeVisible();
  await page.getByText('查看错误详情', { exact: true }).click();
  await page.getByRole('button', { name: /经典视图/ }).click();
  await expect(page.getByLabel('任务类型')).toHaveValue('iteration');
  await page.getByLabel('任务类型').selectOption('ideation');
  await page.getByRole('textbox', { name: '任务要求', exact: true }).fill('用户正在填写的新游戏约束');
  await page.waitForResponse((response) => response.url().includes('/api/status'));
  await expect(page.getByLabel('任务类型')).toHaveValue('ideation');
  await expect(page.getByRole('textbox', { name: '任务要求', exact: true })).toHaveValue(
    '用户正在填写的新游戏约束',
  );
  const originalUrl = page.url();
  await page.getByRole('link', { name: '跳到主要内容' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  await expect(page).toHaveURL(originalUrl);
});
