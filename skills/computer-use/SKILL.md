---
name: computer-use
description: Skill guide for controlling the virtual desktop GUI (X11 / VNC) in RVM, including screen capture, mouse movement, clicks, keyboard typing, shortcut execution, and noVNC live viewing.
---

# Computer Use & Desktop Control Skill

The **Computer Use module** in RVM (`rvm/agent/computer.js`, `novnc.js`, `tightvnc.js`) enables AI agents to visually perceive and interact with an OS desktop environment (X11 / VNC).

---

## 🖥️ Key Features

- **Screenshot Capture**: Take full desktop or window screenshots with coordinate grids.
- **Mouse Interaction**: Move pointer, single/double left click, right click, middle click, drag and drop, mouse scroll.
- **Keyboard Input**: Type text strings, send special key combinations (e.g. `Control+c`, `Alt+Tab`, `Return`, `BackSpace`).
- **Display Resolution**: Query and dynamically change screen resolution (e.g., `1280x800`, `1920x1080`).
- **Web VNC Stream**: Embedded noVNC HTML5 client accessible via browser at `http://localhost:9876/novnc`.

---

## 📡 API Usage

### Endpoint: `POST /computer/action`

#### 1. Take Screenshot
```json
{
  "action": "screenshot"
}
```
*Response*: Returns base64 encoded PNG image data and screen dimensions `(width, height)`.

#### 2. Click Coordinates
```json
{
  "action": "click",
  "coordinate": [450, 320],
  "button": "left"
}
```

#### 3. Move Mouse
```json
{
  "action": "mouse_move",
  "coordinate": [600, 400]
}
```

#### 4. Type Text
```json
{
  "action": "type",
  "text": "npm start\n"
}
```

#### 5. Press Key / Combination
```json
{
  "action": "key",
  "key": "Control_L+c"
}
```

#### 6. Drag Mouse
```json
{
  "action": "drag",
  "start": [100, 100],
  "end": [500, 500]
}
```

---

## 💡 Best Practices

1. **Coordinate Verification**: Always capture a screenshot first to confirm UI layout before calculating target click coordinates `[x, y]`.
2. **Key Names**: Standard X11 key names are supported (`Return`, `Tab`, `Escape`, `BackSpace`, `Control_L`, `Alt_L`, `Shift_L`, `Super_L`).
3. **Delay between inputs**: Allow short pauses (100–300ms) between typing and clicking to allow desktop apps to register events and update frames.
