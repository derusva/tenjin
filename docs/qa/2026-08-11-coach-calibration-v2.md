# Coach Calibration v2 QA Gate

## Scope

This gate checks the behavior produced by the fixed Coach prompt. Unit tests freeze the prompt and transfer contract; they cannot prove the quality of a model response. Run these samples in a fresh conversation that has received only the current Tenjin Coach setup prompt.

The samples are synthetic game dialogue. The runtime prompt may carry the short, non-identifying positive/negative anchors needed to preserve this user's teaching boundary; the full Golden answers and private learning history stay out of the runtime prompt.

## Gate 1: nonliteral chunk selection

Input:

```text
みんなが桃生課長への愚痴とか言ってるときも絶対に乗ってこないし。
直属の部下で一番怒られてるのに。
```

Pass conditions:

- translates both sentences;
- selects `愚痴（ぐち）` and `乗ってこない（のってこない）` as the teaching points;
- gives each selected point its core meaning and its meaning in this sentence;
- does not spend a teaching slot on `とか`, the basic passive, or `のに`;
- every selected Japanese point displays its current-form kana reading.

## Gate 2: global priority and cap

Input:

```text
女子力が低いな。
手荒れにも火傷にも何にでも効くし、量もすごいお得なの。
実はお父さんがずっと愛用してたやつで、私も小さい頃よく塗ってもらってた。
…言ったっけ？
私のお父さん、警察官だったって。
曲がったことが大嫌いで、常に正しさを追求し続けて…
```

Pass conditions:

- translates every sentence before teaching;
- selects no more than three teaching points;
- the three teaching points are `女子力（じょしりょく）`, `言ったっけ（いったっけ）`, and `曲がったことが大嫌い（まがったことがだいきらい）`;
- `愛用してたやつ` does not displace those three higher-priority points;
- does not spend a teaching slot on transparent `何にでも効く`, `お得`, ordinary quotation `って`, or transparent `正しさを追求し続けて`;
- every selected point includes the current-form kana reading, core meaning, and current-context meaning.

## Gate 3: directed question routing

After either sample, ask only for the reading of one expression.

Pass conditions:

- answers that expression directly with its current-form kana reading and only the minimum context needed;
- does not translate or rescan the entire prior sample;
- does not output JSON.

## Gate 4: `整理` transfer

Send the exact message `整理`.

Representative valid item:

```json
{
  "schema": "tenjin.coach-transfer/v1",
  "items": [
    {
      "type": "lookup",
      "focus": "乗ってこない",
      "sourceExcerpt": "みんなが桃生課長への愚痴とか言ってるときも絶対に乗ってこないし。",
      "answer": "读音：のってこない。这里表示不跟着加入大家的抱怨。"
    }
  ]
}
```

Pass conditions:

- returns exactly one `json` fenced block with no text outside it;
- returns 0–3 items, targeting 1–2 rather than serializing every teaching point;
- each item has only `type`, `focus`, `sourceExcerpt`, and `answer`;
- `focus` is a pure Japanese chunk without kana parentheses or Chinese labels;
- `sourceExcerpt` is copied from the original Japanese sentence;
- `answer` begins with `读音：假名。` and then gives the current-context meaning;
- no `reading` field or other extra field appears.
