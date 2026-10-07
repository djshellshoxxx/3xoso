import { test, expect } from '@playwright/test'
test('renders the complete learning instrument shell', async ({ page }) => {
  await page.goto('/3xoso/')
  await expect(page.getByRole('heading', { name: /3xOSO/ })).toBeVisible()
  await expect(page.getByText('OSC 1')).toBeVisible()
  await expect(page.getByText('OSC 2')).toBeVisible()
  await expect(page.getByText('OSC 3')).toBeVisible()
  await expect(page.getByText('LIVE SYNTHESIS MATH')).toBeVisible()
})
