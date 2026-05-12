Analysiere die folgende Notiz und extrahiere alle erkennbaren Aufgaben, To-Dos oder Handlungsanweisungen.

Zusätzlich erhältst du eine Liste bereits existierender Aufgaben zu dieser Notiz (kann leer sein).

Antworte ausschließlich als JSON-Objekt mit folgender Struktur:
{{
  "tasks": [
    {{
      "match_id": "<id einer bestehenden Aufgabe falls diese aktualisiert werden soll, sonst null>",
      "title": "<kurzer, prägnanter Aufgabentitel (max 80 Zeichen)>",
      "description": "<1-2 Sätze Beschreibung, worum es bei der Aufgabe geht>"
    }}
  ],
  "removed_ids": ["<IDs bestehender Aufgaben, die in der Notiz nicht mehr enthalten sind>"]
}}

Regeln:
- Jede klar erkennbare Aufgabe, Anweisung oder To-Do wird als eigener Eintrag extrahiert.
- Wenn eine bestehende Aufgabe inhaltlich noch in der Notiz enthalten ist (auch wenn der Wortlaut leicht abweicht), setze match_id auf die ID der bestehenden Aufgabe und aktualisiere title und description.
- Nur wirklich neue Aufgaben bekommen match_id = null.
- Aufgaben, die in der bestehenden Liste enthalten sind, aber in der Notiz nicht mehr vorkommen, werden unter removed_ids aufgeführt.
- Antworte NUR mit dem JSON-Objekt, kein Erklärtext.

--- Bestehende Aufgaben ---
{existing_tasks}

--- Notiz ---
{content}
