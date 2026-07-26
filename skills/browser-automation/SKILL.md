---
name: browser-automation
description: Skill guide for web browser automation, page navigation, DOM element tagging & annotation, element interactions, and web data extraction in RVM.
---

# Browser Automation & DOM Grounding Skill

The **Browser Automation module** in RVM (`rvm/agent/browser.js`, `annotateDom.js`) provides Playwright/Puppeteer browser automation combined with smart DOM annotation.

---

## 🌐 Key Capabilities

- **DOM Element Tagging (`annotateDom.js`)**: Injects bounding boxes and unique numerical IDs onto visible interactable HTML elements (buttons, inputs, links, forms) on any webpage.
- **Visual Grounding**: Allows AI models to click, type, or hover using explicit element IDs (e.g. `[elementId: 12]`) rather than fragile CSS selectors or pixel coordinates.
- **Page Navigation**: Open URLs, go back/forward, reload, adjust viewport dimensions.
- **Form Automation**: Type into input fields, select dropdown options, check/uncheck boxes, upload files.
- **Content Inspection**: Extract page HTML, inner text, accessible tree, console logs, and network traffic.

---

## 📡 API Usage

### Endpoint: `POST /browser/action`

#### 1. Navigate to URL
```json
{
  "action": "navigate",
  "url": "https://github.com/LebsChen/RVM"
}
```

#### 2. Get Annotated Page View & Screenshot
```json
{
  "action": "annotate"
}
```
*Response*: Returns screenshot image with highlighted element boxes + list of tagged elements with IDs, tag names, text content, and coordinates.

#### 3. Click Element by Tag ID
```json
{
  "action": "click_element",
  "elementId": 14
}
```

#### 4. Type into Input Field by Tag ID
```json
{
  "action": "type_element",
  "elementId": 5,
  "text": "RVM Agent"
}
```

#### 5. Scroll Page
```json
{
  "action": "scroll",
  "direction": "down",
  "amount": 500
}
```

---

## 💡 Best Practices

1. **Annotate First**: Call `annotate` before performing click or type actions to ensure element IDs match current page state.
2. **Handle Dynamic Content**: Wait for page load or network idle state after navigation before querying elements.
3. **Headless & Headed Modes**: Headless mode is default for background tasks; switch to headed mode if viewing browser via VNC desktop.
