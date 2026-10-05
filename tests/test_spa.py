from playwright.sync_api import sync_playwright, expect


def test_spa(simplehttpserver):
    # sensorbox replaces upstream's selector UI. The recipes it lists are
    # served by sensorbox's own nginx (/recipes/), which this static server
    # does not provide, so the page reports that it could not load them.
    # That still proves the page and its modules load without script errors.
    with sync_playwright() as p:
        browser = p.firefox.launch()
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda err: errors.append(str(err)))
        page.goto("http://localhost:8000/www/")
        assert "sensorbox" in page.title()

        expect(page.locator("#sensorbox-device")).to_be_visible()
        expect(page.locator("#sensorbox-build")).to_be_disabled()
        expect(page.locator("body")).to_contain_text("Failed to load recipes")
        assert errors == []

        browser.close()
