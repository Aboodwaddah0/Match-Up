---
name: PitchCraft Athletic
colors:
  surface: '#effdf3'
  surface-dim: '#cfddd4'
  surface-bright: '#effdf3'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#e9f7ed'
  surface-container: '#e3f1e7'
  surface-container-high: '#ddece2'
  surface-container-highest: '#d8e6dc'
  on-surface: '#121e18'
  on-surface-variant: '#414943'
  inverse-surface: '#27332d'
  inverse-on-surface: '#e6f4ea'
  outline: '#717973'
  outline-variant: '#c1c8c2'
  surface-tint: '#3d6752'
  primary: '#002618'
  on-primary: '#ffffff'
  primary-container: '#123d2b'
  on-primary-container: '#7da890'
  inverse-primary: '#a4d1b7'
  secondary: '#006d3b'
  on-secondary: '#ffffff'
  secondary-container: '#72fda6'
  on-secondary-container: '#00743f'
  tertiary: '#001f4b'
  on-tertiary: '#ffffff'
  tertiary-container: '#003374'
  on-tertiary-container: '#6a9dff'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#bfedd3'
  primary-fixed-dim: '#a4d1b7'
  on-primary-fixed: '#002114'
  on-primary-fixed-variant: '#254f3b'
  secondary-fixed: '#72fda6'
  secondary-fixed-dim: '#52df8d'
  on-secondary-fixed: '#00210e'
  on-secondary-fixed-variant: '#00522b'
  tertiary-fixed: '#d8e2ff'
  tertiary-fixed-dim: '#adc6ff'
  on-tertiary-fixed: '#001a42'
  on-tertiary-fixed-variant: '#004395'
  background: '#effdf3'
  on-background: '#121e18'
  surface-variant: '#d8e6dc'
typography:
  headline-xl:
    fontFamily: Manrope
    fontSize: 36px
    fontWeight: '800'
    lineHeight: 44px
    letterSpacing: -0.03em
  headline-xl-mobile:
    fontFamily: Manrope
    fontSize: 30px
    fontWeight: '800'
    lineHeight: 38px
    letterSpacing: -0.025em
  headline-lg:
    fontFamily: Manrope
    fontSize: 26px
    fontWeight: '700'
    lineHeight: 34px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Manrope
    fontSize: 20px
    fontWeight: '700'
    lineHeight: 28px
    letterSpacing: -0.015em
  headline-sm:
    fontFamily: Manrope
    fontSize: 17px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
    letterSpacing: -0.01em
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
    letterSpacing: 0em
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
    letterSpacing: 0.01em
  label-lg:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: -0.005em
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.01em
  label-sm:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '700'
    lineHeight: 14px
    letterSpacing: 0.04em
  stats-display:
    fontFamily: Manrope
    fontSize: 22px
    fontWeight: '800'
    lineHeight: 26px
    letterSpacing: -0.04em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  gutter: 1rem
  gutter-mobile: 0.75rem
  margin: 1.25rem
  margin-mobile: 1rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2rem
---

## Brand & Style

This design system drives a premium modern football matchmaking and athletic community ecosystem. The core design personality is decisive, kinetic, and refined—merging the tactical precision of professional pitch-side strategy with the polished, frictionless UX of modern performance software.

The UI targets active players, team captains, competitive leagues, and casual weekend footballers seeking organized, high-caliber games. It must evoke trust, athletic drive, and spontaneous camaraderie. 

The aesthetic is built on **Modern Athletic Minimalism**: crisp white surfaces, tactical structural layouts, ultra-clean geometric sans-serif typography, tactile pill tags, and deliberate moments of energetic contrast driven by vibrant pitch-inspired accents. Tactile pitch cues—subtle technical gridlines and micro-pitch markings—anchor the sports identity without cluttering the mobile workspace.

## Colors

The color palette captures the sensory environment of modern football: the deep, prestigious tone of manicured stadium turf juxtaposed against the luminous, electric hue of line markings under floodlights.

### Primary & Accent Roles
- **Primary Turf Green (`#123D2B`)**: Directs structural dominance. Used for primary CTAs, active header states, structural app bars, and high-emphasis display type.
- **Secondary Pitch Green (`#35C878`)**: The kinetic energy driver. Used for active match confirmations, spot countdowns, positive status pills, tactical position highlights, and interactive toggles.
- **Info Blue (`#3B82F6`)**: Reserved for verified player status, game rule updates, and venue information calls.

### Surface Tones & Canvas
- **Background (`#F7F9F7`)**: Soft, desaturated off-white providing glare-free daylight readability outdoors.
- **Surface (`#FFFFFF`)**: Pure crisp white reserved for primary interactive cards, modals, and sheets.
- **Surface Container / Muted (`#EEF3EF`)**: Tonal substrate for inactive states, empty slot holders, and nested data pods.
- **Border / Outline (`#E1E7E3`)**: Low-contrast architectural borders enforcing clean visual boundaries without visual bulk.

### Text Contrast
- **Main Text / On-Surface (`#17231D`)**: High-contrast, dark charcoal providing readable performance under harsh sun.
- **Secondary Text (`#78847D`)**: Medium-contrast muted pitch gray for metadata, sub-labels, and timestamps.

### System Indicators
- **Positive / Active**: `#35C878`
- **Warning / Scarcity**: `#F59E0B` (e.g., "1 Spot Remaining")
- **Urgent / Canceled**: `#EF4444` (e.g., "Match Forfeit")

## Typography

Typography establishes athletic structure through tight letterforms, strong weights, and clear information hierarchy.

- **Manrope** provides authoritative geometric precision for all headline weights and numeric metric readouts (`stats-display`). Its heavy cuts (700, 800) bring sports-journalism energy to team names, scorelines, and match headers.
- **Inter** handles content-dense body layouts, micro-copy, and interface labels. Its neutral, engineered character ensures legibility across fast-scanning mobile scenarios.

### Specialized Treatments
- **Athletic Metrics & Stats**: When displaying match scores, roster counts, or minutes remaining, use `stats-display` with tabular numbers enabled (`font-variant-numeric: tabular-nums`) to prevent jitter in live matches.
- **Tactile Tactical Labels**: Position tokens (`label-sm`), match formats, and tactical tags must always be rendered in full uppercase with `+0.04em` letter spacing for high-speed pitch-side recognition.

## Layout & Spacing

The layout is built for native mobile ergonomics, operating on a fluid 4-column mobile grid system scaling to a responsive 8-column presentation for tablet views.

### Touch Targets and Ergonomics
- The primary interactive bottom area (Thumb Zone) commands a minimum horizontal page margin of `margin-mobile` (16px), expanding to `margin` (20px) on large viewports.
- All tappable cards, buttons, and booking intervals strictly honor a minimum 48px touch height.
- Component-level spacing adheres strictly to a baseline 4px modular scale (`space-xs` through `space-xl`).

### Content Reflow Rules
- **Match Feeds**: Standardize vertical card flow using `space-md` gaps.
- **Team Roster Pitch Grids**: Formations (e.g., 4-3-3, 5v5 diamond) reflow cleanly into vertically stacked tactical rows using `space-sm` row separation on smaller screens.
- **Horizontal Carousels**: Matchday slot carousels bleed to edge using negative canvas margins while maintaining consistent internal scroll snapping.

## Elevation & Depth

Visual hierarchy uses a refined combination of flat tonal layering and ambient soft pitch shadows. Avoid heavy skeumorphic borders or dense drop shadows.

### Elevation Levels
- **Level 0 (Flat Ground)**: Base background `#F7F9F7`. Structural containers and empty position slots sit directly on this plane with `#E1E7E3` 1px hairline perimeter borders.
- **Level 1 (Cards & Feed Panels)**: Primary surface `#FFFFFF` combined with a soft, diffused shadow: `0 4px 20px -2px rgba(18, 61, 43, 0.05)`, edged by a subtle `#E1E7E3` structural border.
- **Level 2 (Dropdowns, Sticky Bars & Floating Action Controls)**: `#FFFFFF` surface with intensified depth: `0 12px 32px -4px rgba(23, 35, 29, 0.08)`, offering clear separation above rolling match feeds.
- **Level 3 (Tactical Modals & Bottom Booking Sheets)**: Backdrop blur (`backdrop-filter: blur(8px)`) over an overlay of `rgba(18, 61, 43, 0.40)`, foregrounded with a pristine white sheet floating with ambient shadow `0 24px 48px -8px rgba(18, 61, 43, 0.16)`.

## Shapes

The shape system blends modern consumer ergonomics with technical athletic discipline.

- **Standard Elements (8px - `roundedness: 2`)**: Used for input fields, filter selectors, team badge containers, and match metadata chips.
- **Cards & Match Hubs (`rounded-lg` - 16px to `rounded-xl` - 24px)**: Matchday cards, VS clash banners, and venue cards use generous corner radii (16px to 24px) to create approachable, tactile touch targets.
- **Tactical Badges & Action Pills (Full Radius - 9999px)**: Tactical role tags (GK, CB, CM, CAM, ST), format chips (5v5, 7v7, 11v11), and spot status badges strictly utilize full-pill radii to differentiate data metrics from structural surfaces.

## Components

### Buttons
- **Primary Match Button**: Height 52px, background `#123D2B`, foreground `#FFFFFF`, font `label-lg`. Border radius 12px. Pressed state reduces opacity to 90% and scales subtly (0.99x).
- **Secondary / Action Pitch Button**: Height 52px, background `#35C878`, foreground `#123D2B`, font `label-lg`. Used for high-intent actions like "Join Match" or "Book Pitch".
- **Ghost / Line Button**: Height 44px, surface `#FFFFFF`, 1px solid border `#E1E7E3`, text `#17231D`.

### Tactical Position Tags
- Fixed-width compact pills (min-width 36px, height 24px) with rounded-full geometry.
- **Unassigned / Open**: Border 1.5px dashed `#78847D`, background transparent, text `#78847D`.
- **Occupied**: Background `#EEF3EF`, text `#17231D`, font `label-sm`.
- **Highlighted / User Match**: Background `#35C878`, text `#123D2B`, font `label-sm` with bold weight.

### Format Badges & Match Metatags
- Compact status capsules displaying format (e.g., `5v5`, `7v7`, `11v11`), turf type (`4G Artificial`, `Natural Grass`), and gender category.
- Rendered in `#EEF3EF` with text in `#123D2B`, height 24px, horizontal padding 8px, rounded-full.

### Spots Remaining Meter
- A two-part component featuring a textual countdown label paired with a micro segmented progress bar.
- Segments match total players required (e.g., 10 segments for 5v5). Filled slots display `#123D2B`, unfilled slots display `#EEF3EF`, and the final remaining spots transition to Warning Amber (`#F59E0B`).

### Team Challenge VS Cards
- High-contrast card divided by a subtle 45-degree tactical diagonal or split layout.
- Left and right quadrants feature 48px circular team emblems, team MMR ratings, and confirmed rosters.
- Center node houses a floating 28px circular `#123D2B` badge with crisp white "VS" typography in `label-sm`.

### Venue Booking Time Slots
- Grid of interactive blocks (height 56px, radius 8px).
- Available state: `#FFFFFF` surface, `#E1E7E3` 1px border, top time label `#17231D` (`label-md`), bottom price `#78847D` (`body-sm`).
- Selected state: `#123D2B` surface, border `#123D2B`, text `#FFFFFF`, price text `#35C878`.
- Unavailable state: `#EEF3EF` surface, diagonal slash pattern, text `#78847D` with 50% opacity.

### Form Inputs & Dropdowns
- Height 48px, background `#FFFFFF`, border 1px solid `#E1E7E3`, radius 8px. Internal padding `0.75rem`.
- Focus state: Border color transitions to `#123D2B` with a 2px outer aura in `rgba(53, 200, 120, 0.25)`.