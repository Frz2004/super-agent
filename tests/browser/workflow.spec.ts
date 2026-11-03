import { test, expect } from '@playwright/test';

test('create dependency workflow, execute both tasks and inspect persisted result', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  const project = page.getByRole('dialog', { name: '新建项目' });
  await project.getByLabel('项目名称').fill('浏览器验收项目');
  await project.getByLabel('项目说明').fill('真实前后端闭环验收');
  await project.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(page.getByRole('heading', { name: '浏览器验收项目', exact: true })).toBeVisible();
  for (const [title, dependency] of [
    ['前置任务 A', ''],
    ['后继任务 B', '前置任务 A'],
  ]) {
    await page.getByRole('button', { name: '新建任务', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '创建任务' });
    await modal.getByLabel('任务标题').fill(title);
    await modal.getByLabel('任务说明').fill('  Real workflow acceptance input  ');
    if (dependency) await modal.getByRole('checkbox', { name: new RegExp(dependency) }).check();
    await modal.getByRole('button', { name: '创建任务', exact: true }).click();
    await expect(modal).not.toBeVisible();
    await expect(page.getByTestId('task-card').filter({ hasText: title })).toBeVisible();
  }
  await page.getByTestId('task-card').filter({ hasText: '后继任务 B' }).click();
  const drawer = page.getByRole('dialog', { name: '任务详情' });
  await expect(drawer.getByRole('button', { name: '开始执行', exact: true })).toBeDisabled();
  await expect(drawer.getByText('需要先完成：前置任务 A')).toBeVisible();
  await drawer.getByRole('button', { name: '关闭任务详情' }).click();
  for (const title of ['前置任务 A', '后继任务 B']) {
    await page.getByTestId('task-card').filter({ hasText: title }).click();
    await expect(drawer.getByRole('button', { name: '开始执行', exact: true })).toBeEnabled();
    await drawer.getByRole('button', { name: '开始执行', exact: true }).click();
    await expect(drawer.getByText('成功', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(drawer.locator('pre')).toContainText('sha256');
    await expect(drawer.getByText('执行成功', { exact: true })).toBeVisible();
    await drawer.getByRole('button', { name: '关闭任务详情' }).click();
  }
  await page.reload();
  await expect(page.getByRole('region', { name: '已完成列' }).getByTestId('task-card')).toHaveCount(
    2,
  );
});

test('mobile layout renders without horizontal page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const projects = await (await page.request.get('/api/projects')).json();
  if (!projects.length)
    await page.request.post('/api/projects', { data: { name: '移动端验收项目' } });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
});
