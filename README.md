# Carnet — anglais C1 complet

Une app de révision (vanilla JS, sans build) pour atteindre le C1 :
vocabulaire, grammaire, phrasal verbs, idiomes, connecteurs logiques,
collocations et nuances de sens — tout dans une seule file de révision à
répétition espacée (SM-2), + un vrai module d'écoute grâce aux audios
multi-catégories.

## Contenu

| Fichier | Contenu |
|---|---|
| `data/vocab.json` | 10 825 mots (déjà présent) |
| `data/grammar.json` | 35 points de grammaire C1 (tous les temps, tous les modaux, conditionnels, passive, discours rapporté, relatives, inversion, cleft sentences, participiales, subjonctif, ellipse, fronting, nominalisation, déterminants, prépositions, question tags...), 114 exercices |
| `data/phrasalverbs.json` | 146 phrasal verbs (définition + exemple) |
| `data/idioms.json` | 87 idiomes |
| `data/connectors.json` | 36 connecteurs logiques |
| `data/expressions.json` | 29 expressions verbales (make progress, take responsibility...) |
| `data/collocations.json` | 42 917 collocations (extraites automatiquement de vocab.json — couvre aussi les prépositions dépendantes : interested in, good at, responsible for...) |
| `data/nuances.json` | 13 groupes de nuances de sens (look/stare/glance...) |
| `data/audio-index.json` | généré par l'outil ci-dessous (absent tant que tu ne l'as pas généré) |

Tout est extensible : ajouter du contenu = éditer un JSON, jamais toucher au
code.

## Mettre en place l'audio — 100% depuis un iPhone, sans ordinateur

Pas de PC ? Pas de terminal, pas de GitHub Desktop (qui n'existe que sur
Mac/Windows) — le repo utilise donc un format audio en **quelques gros
fichiers .zip** au lieu de milliers de petits `.mp3`, parce que l'upload web
de GitHub (le seul utilisable depuis Safari iPhone) est limité à ~25 Mo par
fichier et devient impraticable au-delà d'une centaine de fichiers d'un
coup — mais gère très bien 5 à 10 gros zips.

1. Ouvre `audio-manifest-tool.html` dans Safari (juste en tapant son URL une
   fois qu'il est sur GitHub, ou en l'ouvrant depuis l'app Fichiers). Tout
   se passe dans le navigateur, rien n'est envoyé nulle part.
2. Étape 1 : sélectionne ton dossier audio complet (bouton → *Parcourir* →
   ton dossier → *Tout sélectionner*).
3. Étape 2 : appuie sur *Générer les zips + le manifeste*. L'outil regroupe
   automatiquement tes fichiers en paquets d'environ 20 Mo (`audio-part-1.zip`,
   `audio-part-2.zip`, ...) et prépare `audio-index.json`.
4. Étape 3 : télécharge chaque zip et le fichier `audio-index.json` (iOS
   propose "Enregistrer dans Fichiers" à chaque appui).
5. Étape 4 : sur github.com dans Safari, dans ton dépôt → *Add file → Upload
   files* :
   - dépose `audio-index.json` dans `data/` (remplace l'ancien)
   - dépose chaque `audio-part-N.zip` dans un dossier `audio-zips/` à la
     racine (tape `audio-zips/audio-part-1.zip` comme nom au moment de
     l'upload pour que GitHub crée le dossier automatiquement)
   - valide (*Commit changes*)

L'app (`app.js`) sait lire l'audio directement depuis ces zips au moment de
la lecture : elle ne télécharge que le zip contenant le mot demandé, jamais
tout d'un coup.

(Si tu utilises un jour un ordinateur, `build_audio_index.py` reste
disponible pour faire la même chose en une commande, avec le format simple
un-fichier-par-mot classique.)

## Mettre en ligne sur GitHub — 100% depuis Safari iPhone

1. **Crée un compte GitHub** si besoin, sur github.com.
2. **Crée le dépôt** : appuie sur le **+** en haut → *New repository*.
   Donne-lui un nom (ex. `carnet-anglais`), Public ou Private comme tu veux,
   **ne coche aucune case** (pas de README, pas de .gitignore) →
   *Create repository*.
3. **Envoie le contenu du zip fourni** : dans le dépôt vide, *uploading an
   existing file* (lien proposé directement) ou *Add file → Upload files*.
   Depuis l'app Fichiers, dézippe d'abord `carnet-app-c1-complet.zip` (appui
   long → *Décompresser*), puis sélectionne tout le contenu du dossier
   `repo/` (pas le dossier lui-même) et dépose-le dans la zone d'upload.
   *Commit changes*.
4. **Ajoute l'audio** comme décrit ci-dessus (`audio-index.json` +
   `audio-part-N.zip` dans `audio-zips/`).
5. **Active GitHub Pages** : dans le dépôt → *Settings* → *Pages* (menu de
   gauche) → sous *Build and deployment*, choisis *Deploy from a branch*,
   branche `main`, dossier `/ (root)` → *Save*.
6. Patiente 1-2 minutes, puis ouvre l'URL indiquée
   (`https://<ton-nom-utilisateur>.github.io/<nom-du-repo>/`). L'app doit se
   charger toute seule, vocabulaire + grammaire + audio inclus.

### Pour les prochains lots d'audio (quand tu dépasseras les 2000 mots)

Garde tous tes fichiers audio dans le **même dossier qui grossit** au fil du
temps (ne supprime jamais les anciens, iCloud Drive fonctionne bien pour
ça). À chaque nouveau lot :
1. Relance `audio-manifest-tool.html` sur ce dossier **complet** (anciens +
   nouveaux fichiers ensemble) pour régénérer un manifeste et des zips à
   jour.
2. Remplace `data/audio-index.json` et re-dépose tous les `audio-part-N.zip`
   dans `audio-zips/` via *Add file → Upload files* (les fichiers de même
   nom sont simplement remplacés).

## Écouter un mot qui a plusieurs éléments dans un seul fichier audio

Les catégories collocations / verbes à particule / expressions / exemples
lisent souvent **plusieurs éléments à la suite dans un seul mp3**, séparés
par 4 secondes de silence (ex. toutes les collocations d'un mot dans un seul
fichier). Dans la fiche mot, chaque section listée reprend le même ordre que
l'audio, numéroté, avec son propre bouton ▶ juste au-dessus — tu peux donc
suivre la liste affichée pendant que ça se lit, plutôt que de chercher à
isoler un élément précis (il n'y a pas de fichier séparé par élément, pour
éviter d'exploser encore plus le nombre de fichiers).

## Usage local sans serveur

Si tu ouvres `index.html` directement en double-clic (`file://`), le
navigateur bloque le `fetch()` des JSON par sécurité : l'app retombe alors
sur l'écran de configuration où tu peux sélectionner `vocab.json` et le
dossier audio à la main, comme avant. Pour profiter du chargement
automatique en local aussi, lance un petit serveur, par exemple :

```bash
python3 -m http.server 8000
```
puis ouvre `http://localhost:8000`.

## Les deux personnages

Quand un audio se joue, un petit personnage apparaît en bas à droite et
anime sa bouche : une femme pour les catégories mot/définition/sens, un
homme pour exemples/collocations/expressions/phrasal verbs — pour repérer
d'un coup d'œil quelle voix parle.

## Comment fonctionne la répétition espacée

- Chaque mot/point de grammaire/idiome/etc. a une clé unique
  (`v:123`, `g:4:2`, `p:17`...) et sa propre carte SM-2 (facilité,
  intervalle, nombre de révisions).
- Chaque session mélange automatiquement les modules (vocabulaire +
  grammaire + phrasal verbs + idiomes + connecteurs + collocations +
  nuances) plutôt que de les traiter en bloc.
- Un même mot revient sous des formats différents à chaque répétition
  (carte, QCM traduction, QCM mot, phrase à trous, dictée audio) pour éviter
  la mémorisation superficielle par position.
- L'intervalle entre deux révisions grandit automatiquement quand tu
  maîtrises un élément — c'est le principe même de la répétition espacée :
  moins de répétitions inutiles, pas plus.

## Étendre le contenu plus tard

Chaque fichier JSON dans `data/` suit un schéma simple et documenté dans
`app.js` (section 5, "Unified item registry"). Ajouter un idiome, un
connecteur, un point de grammaire ou plus de phrasal verbs ne demande
qu'une entrée JSON de plus — l'app la prend en compte automatiquement au
prochain chargement.
