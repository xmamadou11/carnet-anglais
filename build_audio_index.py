#!/usr/bin/env python3
"""
À exécuter une seule fois, en local, avant de pousser sur GitHub.

Tes fichiers audio (générés par le générateur Azure) sont nommés :
    <id>_<mot_nettoye>_<categorie>.mp3
categorie ∈ {mot, definition, senses, examples, sensExamples,
             collocations, expressions, phrasalVerbs}
ex: "42_abandon_mot.mp3", "42_abandon_examples.mp3"

Ce script :
1. Parcourt ton dossier de fichiers .mp3/.wav.
2. Copie (ou déplace) ces fichiers dans le dossier audio/ du repo.
3. Génère data/audio-index.json : { "<id>": { "<categorie>": "audio/xxx.mp3", ... }, ... }
   pour que l'app charge l'audio directement sur GitHub Pages, sans avoir à
   resélectionner le dossier à chaque ouverture.

Usage (depuis la racine du repo) :
    python3 build_audio_index.py /chemin/vers/ton/dossier/audio
    python3 build_audio_index.py /chemin/vers/ton/dossier/audio --move
"""
import re
import shutil
import json
import argparse
from pathlib import Path

CATEGORIES = ['mot', 'definition', 'senses', 'examples', 'sensExamples',
              'collocations', 'expressions', 'phrasalVerbs']
PATTERN = re.compile(r'^(\d+)_.+_(' + '|'.join(CATEGORIES) + r')\.(mp3|wav)$')

def parse(filename: str):
    m = PATTERN.match(filename)
    if not m:
        return None
    return int(m.group(1)), m.group(2)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('source_dir', help="Dossier contenant tes fichiers audio")
    ap.add_argument('--move', action='store_true', help="Déplacer au lieu de copier")
    ap.add_argument('--repo-root', default='.', help="Racine du repo (par défaut: dossier courant)")
    args = ap.parse_args()

    source = Path(args.source_dir)
    repo_root = Path(args.repo_root)
    audio_dest = repo_root / 'audio'
    audio_dest.mkdir(parents=True, exist_ok=True)
    data_dir = repo_root / 'data'
    data_dir.mkdir(parents=True, exist_ok=True)

    manifest = {}
    count = 0
    skipped = 0
    per_category = {c: 0 for c in CATEGORIES}

    for f in sorted(source.iterdir()):
        if not f.is_file() or f.suffix.lower() not in ('.mp3', '.wav'):
            continue
        parsed = parse(f.name)
        if parsed is None:
            skipped += 1
            continue
        wid, category = parsed
        dest = audio_dest / f.name
        if args.move:
            shutil.move(str(f), str(dest))
        else:
            shutil.copy2(str(f), str(dest))
        manifest.setdefault(str(wid), {})[category] = f'audio/{f.name}'
        per_category[category] += 1
        count += 1

    with open(data_dir / 'audio-index.json', 'w', encoding='utf-8') as out:
        json.dump(manifest, out, ensure_ascii=False, indent=1)

    print(f"Fichiers traités : {count}")
    for c in CATEGORIES:
        if per_category[c]:
            print(f"  - {c}: {per_category[c]}")
    if skipped:
        print(f"Fichiers ignorés (nom non reconnu) : {skipped}")
    print(f"Mots avec au moins un audio : {len(manifest)}")
    print(f"Manifeste écrit dans {data_dir / 'audio-index.json'}")
    print(f"Fichiers audio copiés dans {audio_dest}")

if __name__ == '__main__':
    main()
