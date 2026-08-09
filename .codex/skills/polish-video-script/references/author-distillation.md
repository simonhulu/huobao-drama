# Author Distillation Routing

Load after the truth, episode narrator stance, genre, and retention contracts are locked. Author distillation controls reasoning, material pressure, paragraph movement, and spoken texture. It does not validate facts or choose the central promise. The narrator persona controls who is speaking, what moral direction their judgment has, and how their spoken presence differs from a neutral explainer.

## Asset Boundary

This repository currently supplies a hybrid operating system, genre/style routers, contracts, sentence moves, ending patterns, and final QA. It does not supply a complete folder of raw per-author `outline_patterns.json`, `paragraph_moves.jsonl`, or author-specific QA files.

Do not invent those missing assets or claim an individual author supplied a move. In this skill, `bohai`, `banfo`, and `wenboling` are functional reasoning labels inherited from the hybrid router. They select a way of examining the current material; they do not authorize imitation or impose a whole-article template.

The layer order in `SKILL.md` overrides operational wording inside any distilled asset. In particular, an asset may not move author routing ahead of the truth contract, force a fixed number of topic candidates, or turn a generic outline pattern into the script's architecture.

## Required Route

    primary_genre: ""
    retention_shell: ""
    narrator_persona:
      id: rural-middle-storyteller-v1
      stance: "我认定______。"
      stance_fact_ids: []
      stance_reveal_beat: ""
      false_moral_frame: ""
      rebuttal: ""
      moral_geometry:
        anger_target: ""
        compassion_target: ""
        silent_party: ""
      situation_restore:
        information_gap: ""
        time_pressure: ""
        cost_of_refusal: ""
        environmental_pull: ""
      temperature_arc: []
    author_route:
      reasoning_module: bohai | banfo | wenboling
      paragraph_modules: []
      sentence_moves: []
    voice_palette:
      narrator_attention: []
      spoken_connectors: []
      loaded_verbs_or_nouns: []
      rhythm_preference: ""
      implicit_judgment: ""

Use at most one primary reasoning module. Paragraph modules may vary by task. Sentence moves are selected only after the beat map exists.

The persona contract has precedence over generic voice preferences: a ledger, a village/workplace comparison, or a sharp verdict is useful only when it serves the contracted stance. Never use the persona as an automatic "利益" overlay, a catchphrase bank, or a pretext to accuse every historical figure of setting a trap.

## Module Boundaries

| Module | Use it for | Do not use it for |
| --- | --- | --- |
| 渤海 | Actual pressure, available cards, blocked options, choices, and consequences | Turning a biography or battle list into causal proof |
| 半佛 | Benefits, costs, incentives, ledgers, and who pays | Treating every historical relationship as an economic transaction |
| 温伯陵 | Long arcs, institutions, people reshaping structures, and aftereffects | Compressing a concentrated incident into a grand fate slogan |

The hybrid operating system and any available outline pattern are reasoning constraints, not the automatic source of the full outline. They may be used only when their phases map to verified changes in the story state.

For every 渤海-style phase, record:

    actor: ""
    new_information_or_resource: ""
    blocked_option: ""
    available_options: []
    chosen_action: ""
    immediate_result: ""
    next_phase_forced_by: ""

A character resume, battle record, personality description, or atmosphere note cannot occupy a pressure, card, choice, or consequence phase unless it changes a later actor information, option, risk, or action.

## Voice Palette

Build voice from observed preferences, not copied phrases:

- What does this narrator notice first: a document, room, ledger, relationship, road, or silence?
- Which ordinary spoken bridges make the explanation legible?
- Which concrete nouns expose the pressure?
- How does judgment hide in verb choice and sentence order?
- Where does the narrator slow down, and where does the narrator move like a chronicle?

Do not copy distinctive source phrases, original sentence skeletons, or catchphrases. A sentence move ID is an information-order and rhythm instruction, not a fill-in template.

## Persona-To-Beat Mapping

For every beat, add:

    persona_temperature: cold | warm | hot
    persona_job: ""
    stance_relation: reveal | prove | restore_context | name_cost | rebut | settle

The arc should move through all three temperatures in a full script:

- `cold`: name the ledger, false label, or concrete transfer of cost without hedging.
- `warm`: restore the limited information, time, fear, face, and options of the person trapped inside the choice. This comes after the judgment, not before it.
- `hot`: point at the action, arrangement, or cover-up that benefits upward while someone below pays. The heat names the bill; it never mocks the person holding it.

`stance_reveal_beat` must appear within the first third of the beat map. A script may delay a historical result, but it may not delay what its narrator thinks of the key action until the end.

## Dependency Rule

account persona -> audience motive -> truth boundary -> episode stance -> genre -> retention shell -> author reasoning -> beat task -> paragraph move -> sentence move -> diction

No later layer may revise an earlier layer factual answer.
