# Historical Visual Style Library

This library turns the local study set in
`/Users/mac/Downloads/画面风格学习` into production rules for the
Remotion history factory. It is a source-derived operating reference, not a
bag of creator names. Runtime prompts use observable camera, light, color,
blocking, material, and film-response rules.

## Source inventory learned on 2026-07-19

- Five complete style packages: large-format systems realism, old-color
  Chinese wuxia, structured retro tableau, guofeng editorial portraiture,
  and saturated crime-type cinema.
- One DOCX: Japanese night-street direct-flash snapshot, including its grain,
  exposure, wardrobe, location, and negative rules.
- Eight OCR-verified image cards: Shaw studio wuxia, Republican Shanghai,
  1970s Hong Kong location kungfu, Eastern ink wuxia, Showa nostalgia,
  commercial teal-orange, Northwest rural epic, and Korean cold crime.
- OCR results were checked against the original 1086x1448 cards. The two
  material corrections that matter are `50mm` for Showa nostalgia and the
  complete ink-wuxia color/light paragraph that OCR initially dropped.

## Non-negotiable method

1. Lock content before style: people, count, identity, era, place, action,
   relationship, gaze, props, aspect ratio, and required exclusions.
2. Select one primary capture engine. Do not average several references into
   an attractive but incoherent prompt.
3. Express style as visible mechanisms, never only a creator name or an
   adjective such as cinematic, premium, epic, or atmospheric.
4. Separate the series profile from the per-shot `look`. The profile freezes
   photographic grammar; `look` chooses the concrete palette, light position,
   and mood required by that shot.
5. Use one main action, one spatial relationship, one light logic, and at most
   one visual anchor per cell. A more detailed prompt is not automatically a
   better prompt.
6. Make light physical: state its source, direction, coverage, forbidden
   regions, and background exposure relationship.
7. Make color spatial: state the largest color field, supporting field, small
   accent, and where each color exists. Grain and LUT names cannot repair a
   missing light-color architecture.
8. Describe film response through black density, midtones, highlight rolloff,
   optical softness, and grain behavior. Vintage never automatically means
   grey, brown, underexposed, scratched, or low saturation.
9. Keep negative constraints profile-specific. Do not append one universal
   blacklist to every scene.
10. Preserve originality: do not copy recognizable faces, exact costumes,
    text, logos, plots, or complete compositions from reference material.

## Executable profiles

Runtime ids and full prompt mechanisms live in
`backend/src/services/history-visual-style.ts`.

| Profile id | Visual engine | Strongest uses | Do not use as |
| --- | --- | --- | --- |
| `historical_systems` | grounded geography, real objects and systems, sourced light, sparse 35mm frames | biography, business, industry, migration, war logistics | a fixed dark palette or endless fog |
| `period_crime_35mm` | camera embedded in the scene, one object gaze, lingering frame, dense color print | fraud, transaction, media power, confrontation | guns, wet neon, black suits by default |
| `institutional_tableau` | level frontal symmetry, repeated props, handcrafted period set, restrained performance | banks, post offices, newspapers, queues, bureaucracy | every emotional or action scene |
| `republican_shanghai` | 50mm Art Deco order, tungsten skin, green-cool shadows, refined material highlights | Republican urban stories | global amber or modern neon |
| `showa_nostalgia` | eye-level 50mm, window/side-back natural light, gentle faded palette | domestic memory and quiet daily life | high-key lifestyle advertising |
| `northwest_epic` | 24-35mm landscape scale, low natural light, earth texture, explicit horizon | land, labor, migration, family fate | golden inspirational tourism |
| `korean_crime` | off-center 35/50mm, foreground obstruction, cold flat location light | investigation and social pressure | unreadable black frames or teal-orange streaming looks |
| `studio_wuxia` | artificial three-plane set, frontal hard light, top rim, saturated Eastmancolor | 1970s studio wuxia | modern location realism |
| `location_kungfu` | 28-35mm full-body action, direct sun, handheld/zoom breathing | alleys, courtyards, training, chase | cropped limbs or effect-driven action |
| `ink_wuxia` | long-lens compression, large blank space, mist daylight, restrained ink palette | solitary travel and poetic landscape | ink illustration or xianxia CGI |
| `old_color_wuxia` | practical foreground plus painted-distance space, graphic blocking, one color world | bamboo, waterfall, reeds, moonlit wuxia | modern grey digital costume drama |
| `guofeng_editorial` | exactly one portrait engine, dark ambient, dense crop, localized highlight bloom | wardrobe, ceremony, mirrors, intimate portraits | bright even hanfu catalog lighting |
| `night_flash_snapshot` | on-axis flash, imperfect vertical crop, cold night color, heavy visible noise | modern youth/nightlife or subjective memory | historical-period default |
| `commercial_teal_orange` | modern digital separation and HDR response | explicitly commercial modern action imagery | a generic history-factory substitute |

## Profile boundaries

- `historical_systems` and `period_crime_35mm` can share physical realism, but
  not camera logic. The former first explains geography and systems; the
  latter first controls gaze from inside a transaction space.
- `institutional_tableau` uses deliberate symmetry. `period_crime_35mm` uses
  unequal visual weights and embedded obstruction. Do not combine both in one
  sheet.
- `night_flash_snapshot` requires hard near-axis flash, strong noise, casual
  crop, and imperfect focus. It conflicts with the soft old-color transfer of
  `old_color_wuxia` and the natural-light restraint of `historical_systems`.
- `location_kungfu` needs readable full-body mechanics. `guofeng_editorial`
  encourages crop and obstruction. Choose according to whether action or
  garment/presence is the actual information.
- `ink_wuxia` is live-action photographic minimalism, not a painting medium.
  Keep cloth and environment physically photographed.
- Commercial teal-orange is an explicit opt-in profile. It must never leak
  into another profile as a generic meaning of cinematic.
- Heavy grain belongs to direct-flash snapshots and 1970s location kungfu.
  Old-color wuxia uses almost invisible grain; Showa uses fine grain; crime
  35mm uses irregular luminance-dependent grain.

## Selection rule for a series

Choose one profile before paid reference generation. Keep it for every Episode
inside the same content project unless the user explicitly asks for a new
project style. The selected profile is stored on `dramas.style`; character
cards, scene references, decompose `look`, shot image generation, pilots, and
full renders all resolve through that single field.

Style is selected only by the user. If the user names a Chinese label or
profile id, map it to `dramas.style` before any paid reference generation.
Examples: `民国上海复古` -> `republican_shanghai`, `西北乡土史诗` ->
`northwest_epic`, `邵氏棚拍武侠` -> `studio_wuxia`, `七十年代实景功夫` ->
`location_kungfu`, `东方水墨武侠` -> `ink_wuxia`, `旧彩浪漫武侠` ->
`old_color_wuxia`, `古风暗场时尚` -> `guofeng_editorial`, `夜街直闪快照` ->
`night_flash_snapshot`, `现代青橙商业` -> `commercial_teal_orange`.
If the user has not selected a profile, stop and ask which one to use. Do not
infer, recommend, or persist a style on the user's behalf.

Do not silently switch style per Episode or per shot. Per-shot `look` may vary
palette, light, and mood inside the selected profile, but it may not introduce
a second capture engine. Changing `drama.style` changes the resolved profile.
The next grid decompose run treats cells recorded under another `styleProfile`
as stale and rebuilds their descriptions before image generation.

For a new profile or a disputed style:

1. Select one representative shot with a face, a period prop, and readable
   foreground/midground/background.
2. Generate no more than three same-shot candidates with identical content,
   references, aspect ratio, and provider settings.
3. Compare capture mechanism, composition, light hierarchy, color placement,
   film response, face/era continuity, and text cleanliness.
4. Approve one profile. Do not merge the favorite color from one sample with
   the favorite camera from another without a new controlled pilot.
5. Only after the pilot passes may the full Episode generate sheets.

## Rockefeller reference candidate

`historical_systems` is one controlled candidate for `骗子之子`, not an
automatic choice and not the old lead-grey/candle-gold duotone. The story needs ordinary poverty, bookkeeping,
rail and oil logistics, institutional scale, and the physical rise of a
business system. Its shot palettes should vary by environment while staying
period-coherent:

- childhood/domestic: worn cream, smoke blue, dark wood, one low amber point;
- bookkeeping/institution: ink green, walnut, aged paper, oxblood accent;
- rail/oil/industry: coal black, oxidized steel blue, old ivory, rust red;
- public power: dark navy, stone grey, brass, restrained flag red.

`period_crime_35mm` and `institutional_tableau` are valid controlled A/B
candidates if the editorial direction shifts respectively toward fraud/power
or toward institutional irony. They should be tested as whole profiles, not
layered over `historical_systems` in the same sheet.

## Review rubric

Score each candidate against the selected profile, not against all source
styles at once:

| Axis | Weight |
| --- | ---: |
| capture engine and camera position | 20 |
| composition and visual hierarchy | 20 |
| sourced light, coverage, and exposure separation | 20 |
| color field placement and black/midtone/highlight response | 15 |
| period, face, costume, and prop continuity | 15 |
| optical texture and absence of AI/commercial artifacts | 10 |

Below 80 requires rework. A pretty frame with the wrong capture engine is a
failure, not a partial pass.
