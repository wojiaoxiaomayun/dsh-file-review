<div align="center">

# DSH File Review

**Examinez chaque fichier qu'un agent vient de modifier—sans quitter DeepSeek Harness Web.**

![DeepSeek Harness 0.1.x](https://img.shields.io/badge/DeepSeek%20Harness-0.1.x-4f46e5)
![Web profile](https://img.shields.io/badge/profile-Web-0ea5e9)
[![npm version](https://img.shields.io/npm/v/dsh-file-review.svg)](https://www.npmjs.com/package/dsh-file-review)
[![GitHub repository](https://img.shields.io/badge/GitHub-Repository-181717?logo=github)](https://github.com/left0ver/dsh-file-review)
[![MIT License](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)

[English](README.md) · [简体中文](README.zh.md) · Français

</div>

## Comment l'utiliser

<p align="center">
  <strong>💬 Chat &nbsp;→&nbsp; ✨ Generate &nbsp;→&nbsp; 📄 Click a changed file &nbsp;→&nbsp; 🔍 Review</strong>
</p>

## Aperçu

![leftover](./assests/preview.png)

## Fonctionnalités

1. Un panneau de diff pour examiner instantanément chaque fichier que l'agent vient de modifier.
2. Prise en charge de l'annulation pour revenir sur les modifications de l'agent de la session en cours.

## Démarrage rapide

### 0. Ajouter dsh-file-review à la liste blanche de l'âge minimum de publication de pnpm

Ouvrez `~/.dsh/profiles/web/pnpm-workspace.yaml` et ajoutez :

```yaml
minimumReleaseAgeExclude:
  - dsh-file-review
```

Les versions récentes de `pnpm` imposent un âge minimum de publication : les paquets récemment publiés ne sont pas installés tant que cette période d'attente n'est pas écoulée. Pour installer la dernière version, ajoutez `dsh-file-review` à la liste d'exclusion.

### 1. Installer le plugin

```sh
dsh plugin --profile web add dsh-file-review
```

### 2. Démarrer DSH Web

```sh
dsh web
```

### 3. Profitez-en

## Installer depuis les sources

```sh
git clone https://github.com/left0ver/dsh-file-review.git
cd dsh-file-review
pnpm install
pnpm run build
dsh plugin --profile web add ${PWD}
```

## Installer depuis le dépôt GitHub

```sh
dsh plugin --profile web add github:left0ver/dsh-file-review
```

## Mettre à jour le plugin

```sh
dsh plugin --profile web update dsh-file-review
```

## Désinstaller le plugin

```sh
dsh plugin --profile web remove dsh-file-review
```

## Liens amicaux

[LINUX DO](https://linux.do/) — Une nouvelle communauté idéale

## Licence

[MIT](LICENSE)
