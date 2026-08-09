# 🎬 Encre Vidéo — Caviardage & Floutage de Visages en Vidéo (100% Local)

> Application web PWA pour flouter, caviarder et pixeliser des visages et objets dans des vidéos avec **suivi automatique de mouvements** et repères manuels. **Traitement 100% dans votre navigateur**, aucune donnée vidéo ou audio ne quitte votre appareil.

[![Vercel Live Demo](https://img.shields.io/badge/Vercel-Live_Demo-000000?style=for-the-badge&logo=vercel)](https://encre-video.vercel.app)
[![PWA Ready](https://img.shields.io/badge/PWA-100%25_Offline-5A0FC8?style=for-the-badge&logo=pwa)](https://encre-video.vercel.app)
[![License](https://img.shields.io/badge/License-MIT-blue.style=for-the-badge)](#license)

---

## 📱 Installation Directe sur Smartphone (Sans APK)

Encre Vidéo est une **Progressive Web App (PWA)** complète qui s'installe en un clic et s'exécute comme une application native 100% hors-ligne.

### Sur Android (Chrome / Brave / Edge)
1. Ouvrez **[https://encre-video.vercel.app](https://encre-video.vercel.app)** dans votre navigateur.
2. Cliquez sur le bouton **« Installer »** dans l'en-tête de la page.
3. L'application apparaît sur votre écran d'accueil.

### Sur iPhone / iPad (iOS Safari)
1. Ouvrez **[https://encre-video.vercel.app](https://encre-video.vercel.app)** dans Safari.
2. Appuyez sur le bouton **Partager** (icône carré avec flèche vers le haut).
3. Sélectionnez **« Sur l'écran d'accueil »** puis appuyez sur **« Ajouter »**.

---

## ✨ Fonctionnalités Principales

- 🤖 **Détection & Suivi Automatique de Visages** : TensorFlow.js & BlazeFace embarqués pour repérer les visages et faire glisser automatiquement les masques de flou selon leurs mouvements.
- 🎯 **Repères Manuels & Interpolation** : Pour le texte, les plaques d'immatriculation, panneaux ou logos. Placez un repère à $t_1$, déplacez-le à $t_2$, l'application calcule automatiquement le déplacement fluide entre les deux instants.
- 🔒 **100% Local & Confidentiel** : Vos vidéos ne sont jamais envoyées sur aucun serveur.
- 📲 **Partage Système Direct (Web Share Target API)** : Partagez directement une vidéo depuis votre galerie vers Encre Vidéo.
- 🖐️ **Navigation Zoomée (Pinch & 2-Finger Pan / Outil Main ✋)** : Zoomez et naviguez facilement sur des zones précises de la vidéo.
- 🛠️ **Effets Personnalisables** : Caviardage (couleur), Flou gaussien (intensité), Pixelisation (taille de bloc).
- 📹 **Exportation Vidéo HD** : Exportation directe au format WebM avec capture audio.

---

## ⌨️ Raccourcis Clavier

| Raccourcis | Action |
| :--- | :--- |
| `Espace` | Lecture / Pause de la vidéo |
| `M` | Outil Main / Déplacer la vue |
| `R` | Mode Rectangle |
| `O` | Mode Oval / Cercle |
| `K` | Activer / Désactiver le Mode Repère Manuel |
| `+` / `-` | Zoom Avant / Zoom Arrière |

---

## 💻 Développement Local

```bash
# Clonez le dépôt
git clone https://github.com/fnnktkygl-code/encre-video.git
cd encre-video

# Installez les dépendances
npm install

# Lancez le serveur de développement
npm run dev

# Compilez pour la production
npm run build
```

---

## 🛠️ Stack Technique

- **Bundler** : [Vite](https://vitejs.dev/)
- **IA & Suivi de visages** : TensorFlow.js (`@tensorflow/tfjs`) & BlazeFace (`@tensorflow-models/blazeface`)
- **Core Engine** : HTML5 Canvas, HTML5 Video & MediaRecorder APIs
- **Styling** : Vanilla CSS3 avec Variables CSS & Layout Clamped (`100dvh`)
- **PWA & Offline** : Service Worker (`sw.js`), Web App Manifest (`manifest.json`)
- **Déploiement** : [Vercel](https://vercel.com/)

---

## 📄 Licence

MIT License © 2026 Encre Vidéo
