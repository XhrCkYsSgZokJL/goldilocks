#!/usr/bin/env python3
"""
Syncs the iOS asset catalog colors and generates BrandThemeColors.swift
from shared/brand.json.

The theme mode is controlled by brand.json `theme.mode`:
  - "light" (default): standard grayscale palette, white backgrounds
  - "dark": luxury dark palette, near-black backgrounds, designed for
    gold/silver brand accents

Run via `npm run codegen` or directly:

    python3 shared/codegen/sync-brand-colors.py
"""

import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BRAND = os.path.join(ROOT, "shared", "brand.json")
ASSETS = os.path.join(ROOT, "Convos", "Assets.xcassets")
GENERATED = os.path.join(
    ROOT, "Convos", "Config", "BrandThemeColors.generated.swift"
)


# ---------------------------------------------------------------------------
# Asset catalog helpers
# ---------------------------------------------------------------------------

def color_entry(rgb, alpha="1.000"):
    r, g, b = rgb
    return {
        "color": {
            "color-space": "srgb",
            "components": {
                "alpha": str(alpha) if isinstance(alpha, float) else alpha,
                "blue": f"0x{b:02X}",
                "green": f"0x{g:02X}",
                "red": f"0x{r:02X}",
            },
        },
        "idiom": "universal",
    }


def dark_entry(rgb, alpha="1.000"):
    e = color_entry(rgb, alpha)
    e["appearances"] = [{"appearance": "luminosity", "value": "dark"}]
    return e


def write_color(name, light, dark, light_alpha="1.000", dark_alpha="1.000"):
    path = os.path.join(ASSETS, f"{name}.colorset", "Contents.json")
    if not os.path.exists(os.path.dirname(path)):
        return
    data = {
        "colors": [color_entry(light, light_alpha), dark_entry(dark, dark_alpha)],
        "info": {"author": "xcode", "version": 1},
    }
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def write_accent(rgb):
    path = os.path.join(ASSETS, "AccentColor.colorset", "Contents.json")
    data = {
        "colors": [color_entry(rgb)],
        "info": {"author": "xcode", "version": 1},
    }
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


# ---------------------------------------------------------------------------
# Light palette — standard grayscale, white backgrounds
# ---------------------------------------------------------------------------

def write_light_palette():
    BLK = (0x00, 0x00, 0x00)
    WHT = (0xFF, 0xFF, 0xFF)
    G14 = (0x14, 0x14, 0x14)
    G1C = (0x1C, 0x1C, 0x1C)
    G26 = (0x26, 0x26, 0x26)
    G33 = (0x33, 0x33, 0x33)
    G4D = (0x4D, 0x4D, 0x4D)
    G66 = (0x66, 0x66, 0x66)
    G99 = (0x99, 0x99, 0x99)
    GB2 = (0xB2, 0xB2, 0xB2)
    GD9 = (0xD9, 0xD9, 0xD9)
    GEB = (0xEB, 0xEB, 0xEB)
    GF5 = (0xF5, 0xF5, 0xF5)
    GFA = (0xFA, 0xFA, 0xFA)

    write_color("colorTextPrimary", BLK, WHT)
    write_color("colorTextSecondary", G66, G99)
    write_color("colorTextTertiary", GB2, G4D)
    write_color("colorTextInactive", GD9, G33)
    write_color("colorTextPrimaryInverted", WHT, BLK)
    write_color("colorTextDarkBg", WHT, WHT)

    write_color("colorBackgroundRaised", WHT, G26)
    write_color("colorBackgroundRaisedSecondary", GF5, G1C)
    write_color("colorBackgroundSurfaceless", WHT, BLK)
    write_color("colorBackgroundSubtle", BLK, BLK, light_alpha=0.040, dark_alpha=0.300)
    write_color("colorBackgroundInverted", BLK, WHT)
    write_color("colorBackgroundMedia", G1C, G1C)
    write_color("colorBackgroundPic", GF5, G1C)
    write_color("backgroundSurface", G14, G14)

    write_color("colorFillPrimary", (0x22, 0x39, 0x68), WHT)
    write_color("colorFillSecondary", G66, G99)
    write_color("colorFillTertiary", GB2, G4D)
    write_color("colorFillMinimal", GFA, G14)
    write_color("colorFillSubtle", GF5, G33)
    write_color("colorFillInvertedMinimal", G14, GFA)
    write_color("colorFillInvertedSubtle", G33, GF5)

    write_color("colorBubble", BLK, WHT)
    write_color("colorBubbleIncoming", GF5, G33)

    write_color("colorBorderEdge", WHT, BLK, light_alpha=0.080, dark_alpha=0.040)
    write_color("colorBorderSubtle", GEB, G33)
    write_color("colorBorderSubtle2", GEB, G33)

    write_color("colorStandard", G66, G66)
    write_color("colorDarkAlpha15", BLK, BLK, light_alpha=0.150, dark_alpha=0.150)
    write_color("colorVibrantQuaternary", BLK, WHT, light_alpha=0.100, dark_alpha=0.100)
    write_color("colorLinkBackground", BLK, WHT, light_alpha=0.080, dark_alpha=0.080)


# ---------------------------------------------------------------------------
# Dark palette — luxury dark mode, near-black backgrounds
# Both light and dark OS appearances render dark so the app is always dark.
# ---------------------------------------------------------------------------

def write_dark_palette(theme):
    h = theme.get("iconColor", "#4A7ABF").lstrip("#")
    ACCENT = (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))

    # Near-black background tiers
    BG0 = (0x0A, 0x0A, 0x0A)  # deepest — surfaceless
    BG1 = (0x1A, 0x1A, 0x1A)  # raised — cards, rows
    BG2 = (0x0F, 0x0F, 0x0F)  # raised secondary — settings sheets
    BG3 = (0x22, 0x22, 0x22)  # subtle / media
    ROW = (0x1E, 0x1E, 0x1E)  # list row fill — visible against BG0/BG2

    # Text hierarchy on dark backgrounds
    WHT = (0xEB, 0xEB, 0xEB)   # primary text — not pure white, easier on eyes
    SIL = (0x99, 0x99, 0x99)  # secondary — silver tone
    DIM = (0x66, 0x66, 0x66)   # tertiary / muted
    OFF = (0x44, 0x44, 0x44)   # inactive / disabled

    BLK = (0x00, 0x00, 0x00)
    PURE_WHT = (0xFF, 0xFF, 0xFF)

    # Text — same values for both OS appearances (always dark)
    write_color("colorTextPrimary", WHT, WHT)
    write_color("colorTextSecondary", SIL, SIL)
    write_color("colorTextTertiary", DIM, DIM)
    write_color("colorTextInactive", OFF, OFF)
    write_color("colorTextPrimaryInverted", BLK, BLK)
    write_color("colorTextDarkBg", PURE_WHT, PURE_WHT)

    # Backgrounds
    write_color("colorBackgroundRaised", BG1, BG1)
    write_color("colorBackgroundRaisedSecondary", BG2, BG2)
    write_color("colorBackgroundSurfaceless", BG0, BG0)
    write_color("colorBackgroundSubtle", PURE_WHT, PURE_WHT, light_alpha=0.040, dark_alpha=0.040)
    write_color("colorBackgroundInverted", PURE_WHT, PURE_WHT)
    write_color("colorBackgroundMedia", BG3, BG3)
    write_color("colorBackgroundPic", BG1, BG1)
    write_color("backgroundSurface", BG0, BG0)

    # Fills — gold as the primary action color
    write_color("colorFillPrimary", ACCENT, ACCENT)
    write_color("colorFillSecondary", SIL, SIL)
    write_color("colorFillTertiary", DIM, DIM)
    write_color("colorFillMinimal", ROW, ROW)
    write_color("colorFillSubtle", BG3, BG3)
    write_color("colorFillInvertedMinimal", (0xF0, 0xF0, 0xF0), (0xF0, 0xF0, 0xF0))
    write_color("colorFillInvertedSubtle", (0xD0, 0xD0, 0xD0), (0xD0, 0xD0, 0xD0))

    # Bubbles — outgoing gets gold, incoming is dark raised
    write_color("colorBubble", ACCENT, ACCENT)
    write_color("colorBubbleIncoming", BG3, BG3)

    # Borders — subtle lines on dark
    write_color("colorBorderEdge", PURE_WHT, PURE_WHT, light_alpha=0.060, dark_alpha=0.060)
    write_color("colorBorderSubtle", (0x2A, 0x2A, 0x2A), (0x2A, 0x2A, 0x2A))
    write_color("colorBorderSubtle2", (0x2A, 0x2A, 0x2A), (0x2A, 0x2A, 0x2A))

    # Misc
    write_color("colorStandard", SIL, SIL)
    write_color("colorDarkAlpha15", BLK, BLK, light_alpha=0.150, dark_alpha=0.150)
    write_color("colorVibrantQuaternary", PURE_WHT, PURE_WHT, light_alpha=0.080, dark_alpha=0.080)
    write_color("colorLinkBackground", PURE_WHT, PURE_WHT, light_alpha=0.060, dark_alpha=0.060)

    # Accent color uses gold
    write_accent(ACCENT)


# ---------------------------------------------------------------------------
# Swift codegen — Color extensions from brand.json theme
# ---------------------------------------------------------------------------

def hex_to_rgb_floats(h):
    h = h.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return r / 255.0, g / 255.0, b / 255.0


def generate_swift(theme):
    text_r, text_g, text_b = hex_to_rgb_floats(theme["textColor"])
    light_r, light_g, light_b = hex_to_rgb_floats(theme["textColorLight"])
    bg_r, bg_g, bg_b = hex_to_rgb_floats(theme["backgroundColor"])

    icon = theme.get("iconColor")
    logo = theme.get("logoTextColor")

    lines = [
        "import SwiftUI",
        "",
        "extension Color {",
    ]

    if icon:
        ir, ig, ib = hex_to_rgb_floats(icon)
        lines.append(f"    static let brandIcon: Color = Color(")
        lines.append(f"        red: {ir:.4f}, green: {ig:.4f}, blue: {ib:.4f}")
        lines.append(f"    )")

    if logo:
        lr, lg, lb = hex_to_rgb_floats(logo)
        lines.append(f"    static let brandLogoText: Color = Color(")
        lines.append(f"        red: {lr:.4f}, green: {lg:.4f}, blue: {lb:.4f}")
        lines.append(f"    )")

    lines.append(f"    static let brandText: Color = Color(")
    lines.append(f"        red: {text_r:.4f}, green: {text_g:.4f}, blue: {text_b:.4f}")
    lines.append(f"    )")
    lines.append(f"    static let brandTextLight: Color = Color(")
    lines.append(f"        red: {light_r:.4f}, green: {light_g:.4f}, blue: {light_b:.4f}")
    lines.append(f"    )")
    lines.append(f"    static let brandBackground: Color = Color(")
    lines.append(f"        red: {bg_r:.4f}, green: {bg_g:.4f}, blue: {bg_b:.4f}")
    lines.append(f"    )")
    lines.append("}")
    lines.append("")

    with open(GENERATED, "w") as f:
        f.write("\n".join(lines))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    with open(BRAND) as f:
        brand = json.load(f)

    theme = brand.get("theme")
    if not theme:
        print("  (no theme in brand.json, skipping)")
        return

    mode = theme.get("mode", "light")

    if mode == "dark":
        print("  applying dark luxury palette")
        write_dark_palette(theme)
    else:
        print("  applying standard light palette")
        write_light_palette()

    print("  generating BrandThemeColors.generated.swift")
    generate_swift(theme)

    print("  done")


if __name__ == "__main__":
    main()
