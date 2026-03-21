# A/B Testing Tracker — Chrome Extension

> **Real-time A/B test and goal tracking for Convert, Optimizely Web, and VWO**
>
> by Sarthak Rautela · v2.2.0 · Manifest V3

---

## ✨ Features

| Feature | Description |
|---|---|
| 🧪 Multi-Platform | Detects Convert, Optimizely Web, and VWO experiments automatically |
| 🎯 Real-Time Goals | Captures goals as they fire — clicks, page views, engagement, bounce, form submit |
| 🔍 Variation Bucketing | Shows exactly which variation/control you are bucketed into with Exp ID and Var ID |
| 📋 DevTools Panel | Full A/B TRACKER tab inside Chrome DevTools with filter, experiments, and goals log |
| 🏷️ Goal Names | Resolves goal IDs to human-readable names from platform config data where available |
| 🔢 Icon Badge | Green badge on the extension icon shows the count of active experiments |
| 🔄 SPA Support | Detects route changes and re-scans automatically |
| 🔎 Filter & Search | Filter experiments and goals by name, ID, or platform in the DevTools panel |

---

## 🛠 Supported Platforms

| Platform | Experiment Detection | Goal Detection |
|---|---|---|
| **Convert.com** | `currentData.experiences`, `_conv_r`, `_conv_v` cookie, `convert.data` | `goal.triggered` event, network beacon, console log intercept |
| **Optimizely Web** | `getCampaignStates`, `getExperimentStates`, `campaignDecided` listener | `analytics trackEvent` listener, push hook, logx.optimizely.com beacon |
| **VWO** | `_vwo_exp`, `onVariationApplied` callback, `_vis_opt_exp_*_combi` cookie | `_vis_opt_exp_*_goal_*` cookie polling (500ms), `_vis_opt_goal_conversion` hook |

---

## 🚀 How to Install in Chrome

This extension is **not on the Chrome Web Store** — load it directly from your local files using Developer Mode.

**Step 1** — Download or clone this repository:
```bash
git clone https://github.com/yourusername/ab-tracker-extension
```

**Step 2** — Open Chrome Extensions page:
```
chrome://extensions
```

**Step 3** — Enable **Developer Mode** (toggle in the top-right corner)

**Step 4** — Click **"Load unpacked"** → select the extension folder → click **Open**

**Step 5** — (Optional) Pin the extension: click the 🧩 puzzle icon in Chrome toolbar → pin **A/B Test Tracker**

**Step 6** — Navigate to any page running Convert, Optimizely, or VWO tests. Done!

> ⚠️ After any code changes, go to `chrome://extensions` and click the **↻ refresh** icon on the extension card.

---

## 📖 How to Use

### Extension Popup
- Click the **A/B TRACKER** icon in the Chrome toolbar
- Platform badges glow when a platform is detected on the page
- **EXPERIMENTS** tab — active tests, variant name, Exp ID, Var ID
- **GOALS FIRED** tab — goals appear in real-time as they fire
- **CLEAR GOALS** — resets the goal list
- **↻ Refresh** — forces a re-scan of the page

### DevTools Panel
- Open Chrome DevTools (`F12` or right-click → Inspect)
- Click the **A/B TRACKER** tab in the DevTools panel bar
- Same data as the popup with an additional **filter/search bar**
- If goals are not showing, click **↻ refresh** to sync latest data

### Icon Badge
- **Green number** on the extension icon = number of active experiments
- **No badge** = no experiments detected on the current page

---

## 📁 File Structure

```
ab-tracker-extension/
├── manifest.json          # Extension config (Manifest V3)
├── background.js          # Service worker — caches data, manages DevTools port
├── content.js             # Isolated-world bridge — injects injected.js into page
├── injected.js            # Page-world script — reads window.convert / optimizely / VWO
├── popup.html             # Extension popup UI
├── devtools.html          # DevTools entry point
├── devtools.js            # Creates panel, opens port to background
├── panel.html             # DevTools panel HTML
├── panel.js               # DevTools panel logic
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## 🌐 Browser Compatibility

| Browser | Support | Notes |
|---|---|---|
| **Google Chrome** | ✅ Full | Primary target. All features work including DevTools panel |
| **Microsoft Edge** | ✅ Full | Chromium-based. Load unpacked same way as Chrome |
| **Brave Browser** | ✅ Full | Chromium-based. Disable Shields on test pages if needed |
| **Opera** | ⚠️ Mostly | Popup and detection work. DevTools panel may need testing |
| **Firefox** | ❌ No | Different extension format. Manifest V3 service workers not compatible |
| **Safari** | ❌ No | Requires Apple Developer account and Xcode conversion |

---


## 📝 Known Limitations

- **Convert goal names** may show as `Convert Goal {id}` if the project has **Data Anonymization** enabled in Convert settings — this is a platform setting, not an extension bug
- **VWO goal names** are built from goal type (Click, Page View, Engagement etc.) since VWO does not expose goal names in the frontend JS
- **Optimizely goal IDs** are numeric entity IDs from the event beacon
- Goals that fired **before** the extension was loaded on the page will not appear

---

## 📄 License

MIT License — free to use, modify, and distribute.

---

*Built by Sarthak Rautela · A/B Tesing TRACKER v2.2.0 · Manifest V3*
