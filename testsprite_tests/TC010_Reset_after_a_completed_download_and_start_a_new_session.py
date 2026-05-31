import asyncio
import re
from playwright import async_api
from playwright.async_api import expect

async def run_test():
    pw = None
    browser = None
    context = None

    try:
        pw = await async_api.async_playwright().start()
        browser = await pw.chromium.launch(
            headless=True,
            args=[
                "--window-size=1280,720",
                "--disable-dev-shm-usage",
                "--ipc=host",
                "--single-process"
            ],
        )
        context = await browser.new_context()
        context.set_default_timeout(15000)
        page = await context.new_page()
        # -> navigate
        await page.goto("http://localhost:3000")
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=5000)
        except Exception:
            pass
        
        # -> Fill a valid video URL into the URL input (index 3) and click the Get Video button (index 11) to fetch video information.
        # url input placeholder="Paste your video link here..."
        elem = page.locator("xpath=/html/body/main/section/div/div/input").nth(0)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        
        # -> Fill a valid video URL into the URL input (index 3) and click the Get Video button (index 11) to fetch video information.
        # button "Get Video"
        elem = page.locator("xpath=/html/body/main/section/div/div/button[2]").nth(0)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.click()
        
        # -> Click the preset quality download option (Best Quality at index 521) to start the download, wait for completion UI, then click 'Download Another Video' (index 16) to reset the form.
        # "Best Quality ~ 345.3 MB"
        elem = page.locator("xpath=/html/body/main/section[2]/div[2]/div[2]/div/div[3]/div").nth(0)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.click()
        
        # -> Click the preset quality download option (Best Quality at index 521) to start the download, wait for completion UI, then click 'Download Another Video' (index 16) to reset the form.
        # button "Download Another Video"
        elem = page.locator("xpath=/html/body/main/section[2]/button[2]").nth(0)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.click()
        
        # -> Re-enter the video URL into the URL input (shadow index 3) to trigger the input event, then click the Get Video button (index 11) to fetch video information for the second download session.
        # url input placeholder="Paste your video link here..."
        elem = page.locator("xpath=/html/body/main/section/div/div/input").nth(0)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        
        # -> Re-enter the video URL into the URL input (shadow index 3) to trigger the input event, then click the Get Video button (index 11) to fetch video information for the second download session.
        # button "Get Video"
        elem = page.locator("xpath=/html/body/main/section/div/div/button[2]").nth(0)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.click()
        
        # --> Test failed (AST guard fallback)
        raise AssertionError("Test failed during agent run: " + "TEST FAILURE The download form did not reset after using the \"Download Another Video\" control \u2014 a new download session could not be started from a cleared state. Observations: - After clicking 'Download Another Video', the input still contains 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' (visible on the page/screenshot). - The Get Video button is disabled and no download-quality presets are di...")
        await asyncio.sleep(5)
    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    