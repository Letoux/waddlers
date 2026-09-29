# Waddlers

## Super-dashboard de suivi et d'analyse financière

### Version 0.1

---

# 1. Présentation du produit

**Waddlers** est un dashboard personnel permettant de suivre et d'analyser un ensemble de titres financiers : principalement des actions et des ETF.

L'objectif est de proposer une interface claire permettant de répondre rapidement à des questions telles que :

* Quelle est l'évolution générale de mes investissements suivis ?
* Quels titres ont le plus progressé ?
* Quels titres ont le plus baissé ?
* Comment évolue un titre sur le long terme ?
* Quels sont ses principaux indicateurs financiers ?
* Comment comparer rapidement plusieurs titres ?
* Quels titres répondent à certains critères ?

Waddlers est un **outil d'analyse et de visualisation**.

Ce n'est pas :

* une banque ;
* un courtier ;
* une plateforme de trading ;
* une application de passage d'ordres ;
* une application de gestion bancaire ;
* un outil de comptabilité.

Il n'existe donc aucune fonctionnalité d'achat ou de vente de titres dans le périmètre du produit.

---

# 2. Concept d'un espace Waddlers

Un utilisateur dispose d'un ou plusieurs **espaces de suivi**.

Un espace représente un ensemble de titres que l'utilisateur souhaite suivre.

Exemples :

* PEA
* CTO
* Long terme
* ETF
* Actions US
* Watchlist
* Portefeuille familial

Le terme "portefeuille" peut être utilisé dans l'interface si pertinent, mais il ne représente **pas un compte bancaire ni un compte-titres réel**.

Un espace contient simplement une liste de titres suivis et les informations nécessaires à leur analyse.

---

# 3. Philosophie UX

Waddlers doit être :

* clair ;
* rapide ;
* sobre ;
* dense lorsque nécessaire ;
* facilement personnalisable ;
* orienté données ;
* agréable à consulter quotidiennement.

L'application doit éviter l'apparence d'un tableur Excel tout en permettant d'afficher beaucoup d'informations.

## Principe fondamental

> **Montrer beaucoup d'informations sans donner l'impression qu'il y en a trop.**

La hiérarchie visuelle doit être très forte.

L'utilisateur doit pouvoir comprendre l'état général de son espace en quelques secondes.

---

# 4. Stack technique

La stack est imposée pour le projet.

## 4.1 Langage

* TypeScript

L'objectif est d'utiliser TypeScript de bout en bout.

---

## 4.2 Frontend

* React
* Next.js
* Tailwind CSS
* shadcn/ui
* TanStack Query
* TanStack Table
* Recharts
* React Hook Form
* Zod
* Zustand, uniquement lorsque nécessaire pour de l'état UI local/global
* react-toastify pour les notifications utilisateur

### Rôle des technologies

**Next.js**

Framework principal du frontend et de la structure de l'application.

**shadcn/ui**

Composants d'interface principaux :

* boutons ;
* menus ;
* dropdowns ;
* dialogs ;
* inputs ;
* selects ;
* tabs ;
* tooltips ;
* tables ;
* badges ;
* etc.

L'interface doit privilégier les composants shadcn plutôt que de recréer des composants équivalents.

**Tailwind CSS**

Utilisé pour la mise en page et le styling.

**TanStack Query**

Gestion de l'état serveur :

* récupération des données ;
* cache ;
* invalidation ;
* loading ;
* erreurs ;
* synchronisation.

**TanStack Table**

Gestion du tableau principal :

* colonnes ;
* tri ;
* filtres ;
* recherche ;
* visibilité des colonnes ;
* pagination ;
* éventuellement virtualisation.

**Recharts**

Graphiques financiers :

* évolution du portefeuille/espace ;
* évolution des titres ;
* comparaison éventuelle de titres.

**React Hook Form + Zod**

Gestion et validation des formulaires.

**react-toastify**

Notifications utilisateur :

* sauvegarde réussie ;
* erreur de sauvegarde ;
* erreur de récupération des données ;
* modification d'un espace ;
* etc.

Les toasts doivent rester discrets et ne pas devenir le mécanisme principal de communication de l'interface.

---

# 5. Backend

Backend en :

* Node.js ;
* TypeScript ;
* oRPC ;
* Zod ;
* Drizzle ORM.

## API

L'API doit utiliser **oRPC** afin d'avoir un contrat fortement typé entre frontend et backend.

Les données doivent être validées avec Zod.

Le frontend ne doit pas dupliquer les règles métier importantes.

---

# 6. Base de données

Base de données :

**PostgreSQL**

ORM :

**Drizzle ORM**

Les migrations doivent être gérées avec Drizzle.

Les données principales sont :

* utilisateurs ;
* espaces ;
* titres ;
* données de marché ;
* historiques de cours ;
* données financières ;
* devises ;
* places de cotation ;
* configuration des tableaux.

---

# 7. Authentification et espaces utilisateur

L'inscription publique n'existe pas dans le MVP.

Il n'y a **pas de page "Créer un compte" accessible aux utilisateurs**.

Les espaces utilisateurs sont créés manuellement par l'administrateur.

## Fonctionnement

L'administrateur crée un espace/utilisateur.

Il lui attribue :

* identifiant ;
* mot de passe initial ;
* espace ou espaces accessibles.

L'utilisateur peut ensuite se connecter.

## Fonctionnalités MVP

* connexion ;
* déconnexion ;
* session persistante ;
* changement de mot de passe.

## Administration

La création des utilisateurs et espaces est réalisée manuellement par l'administrateur dans un premier temps.

Il n'est pas nécessaire de développer une interface d'administration complète dans le MVP.

---

# 8. Sécurité

Les données doivent être isolées par utilisateur.

Un utilisateur ne doit jamais pouvoir accéder aux données d'un autre espace.

Le backend doit vérifier les autorisations sur chaque ressource.

Les mots de passe doivent être stockés sous forme de hash sécurisé.

Les données reçues du frontend doivent toujours être validées côté serveur.

---

# 9. Espaces de suivi

Un utilisateur peut avoir plusieurs espaces.

Chaque espace contient une liste de titres suivis.

Exemple :

```text
Mes espaces

PEA
├── ETF World
├── Air Liquide
├── Microsoft
└── LVMH

Actions US
├── Apple
├── Microsoft
├── Nvidia
└── Amazon

ETF
├── World
├── S&P 500
└── Nasdaq 100
```

Changer d'espace actualise le dashboard.

---

# 10. Dashboard principal

Le dashboard est la page centrale de Waddlers.

Structure générale :

```text
┌──────────────────────────────────────────────────────────────┐
│ Waddlers                         Espace ▼     Période ▼      │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Valeur suivie                                                │
│ 128 450 €                                                    │
│                                                              │
│ +12 430 €       +10,7 %                                      │
│                                                              │
│                  Graphique                                   │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Plus fortes hausses          Plus fortes baisses             │
│                                                              │
│ Nvidia          +42 %        Company A          -21 %        │
│ ETF World       +18 %        Company B          -17 %        │
│ ...                                                          │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ Tous les titres                                               │
│                                                              │
│ Recherche     Filtres     Colonnes                            │
│                                                              │
│ Société | Code | Cours | Performance | ...                   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

# 11. Sélecteur global de période

Un sélecteur de période est présent en haut du dashboard.

Options :

* **Semaine**
* **Mois**
* **6 mois**
* **1 an**
* **5 ans**
* **Max**

Le choix de cette période doit être utilisé par tous les composants du dashboard qui présentent une évolution temporelle.

Exemple :

Si l'utilisateur sélectionne :

> **6 mois**

alors :

* le graphique principal affiche 6 mois ;
* les performances des titres sont calculées sur 6 mois ;
* le classement des meilleures performances utilise 6 mois ;
* le classement des plus fortes baisses utilise 6 mois.

Il ne doit pas être nécessaire de changer séparément la période de chaque composant.

---

# 12. Valeur générale de l'espace

Le dashboard doit afficher une valeur globale correspondant à la valeur actuelle des titres suivis.

Cette valeur n'est pas présentée comme un solde bancaire.

Exemple :

> **Valeur suivie**
>
> 128 450 €

Sous cette valeur :

> +12 430 €
>
> +10,7 %

La valeur et son évolution sont calculées à partir des titres et quantités configurés dans l'espace.

---

# 13. Graphique principal

Le dashboard doit afficher l'évolution historique de la valeur globale de l'espace.

### Périodes

* semaine ;
* mois ;
* 6 mois ;
* 1 an ;
* 5 ans ;
* max.

### Interaction

Au survol :

```text
18 juin 2026

Valeur
132 540 €

Évolution
+8,4 %
```

Le graphique doit être fluide et lisible.

---

# 14. Meilleures et pires évolutions

Deux blocs doivent être présents :

### Plus fortes progressions

Liste des titres ayant le plus progressé sur la période sélectionnée.

### Plus fortes baisses

Liste des titres ayant le plus baissé sur la période sélectionnée.

Chaque élément affiche :

* nom ;
* code ;
* performance.

Le nombre d'éléments affichés par défaut peut être de 5.

Un clic sur un titre ouvre sa fiche détaillée.

---

# 15. Tableau des titres

Le tableau constitue le principal outil d'analyse détaillée.

Il doit permettre d'afficher tous les titres de l'espace.

Il doit être hautement configurable.

## Fonctionnalités

Le tableau doit permettre :

* recherche ;
* filtres ;
* tri ;
* affichage/masquage de colonnes ;
* réorganisation des colonnes ;
* configuration persistante ;
* pagination ou virtualisation si nécessaire.

---

# 16. Colonnes du tableau

Le tableau doit être **personnalisable par l'utilisateur**.

L'utilisateur peut choisir les colonnes qu'il souhaite voir.

Il peut :

* ajouter une colonne ;
* retirer une colonne ;
* modifier l'ordre des colonnes ;
* revenir à la configuration par défaut.

La configuration doit être sauvegardée.

Exemple :

```text
Colonnes affichées

☑ Société
☑ Code
☑ Cours EUR
☑ Capitalisation
☑ Perf. 12 mois
☐ Dette nette
☐ VE
☐ Dividende
☐ Rendement
```

---

# 17. Liste des colonnes disponibles

Les colonnes disponibles sont issues de la liste suivante.

### Identification

* Société
* Code
* Type d'instrument
* Place de cotation retenue
* Logique de choix de la place
* Devise
* Secteur d'activité

### Description

* Activité & positionnement concurrentiel

### Cours

* Cours dans la devise locale
* Taux de change → EUR
* Cours en EUR
* Date du cours

### Valorisation

* Capitalisation dans la devise locale
* Capitalisation en EUR
* Valeur d'entreprise
* VE / Capitalisation

### Endettement

* Dette nette
* Taux d'endettement
* Nature du ratio d'endettement

### Actionnariat

* Principaux actionnaires

### Dividendes

* Dividende annuel
* Rendement du dividende

### Performance

* Performance 1 semaine
* Performance 1 mois
* Performance 6 mois
* Performance 12 mois
* Performance 60 mois
* Performance Max

La colonne **Performance période** est également disponible.

Elle correspond automatiquement à la période globale sélectionnée.

---

# 18. Tableau par défaut

Même si toutes les colonnes sont disponibles, le tableau ne doit pas afficher toutes les informations simultanément par défaut.

Configuration initiale recommandée :

| Colonne                |
| ---------------------- |
| Société                |
| Code                   |
| Cours EUR              |
| Capitalisation EUR     |
| Secteur                |
| Rendement du dividende |
| Performance période    |
| Performance 12 mois    |
| Performance 60 mois    |

L'utilisateur peut ensuite ajouter toutes les autres colonnes.

---

# 19. Persistance de la configuration du tableau

La configuration du tableau doit être propre à l'utilisateur et à l'espace.

Exemple :

```text
Utilisateur A
  └── Espace PEA
       └── Configuration tableau A

  └── Espace Actions US
       └── Configuration tableau B
```

Changer la configuration du tableau dans "PEA" ne doit pas modifier celle de "Actions US".

La configuration doit être restaurée lors de la prochaine connexion.

---

# 20. Recherche globale du tableau

La recherche doit fonctionner sur tous les champs pertinents disponibles dans les données.

Exemples :

```text
apple
```

→ Apple Inc.

```text
AAPL
```

→ Apple Inc.

```text
technology
```

→ titres correspondant au secteur.

```text
USD
```

→ titres libellés en USD.

La recherche doit être insensible à la casse.

Pour les gros volumes, la recherche doit être effectuée côté serveur.

---

# 21. Filtres

Les filtres doivent être combinables.

Exemple :

```text
Secteur = Technologie
ET
Capitalisation > 100 Md€
ET
Performance 12 mois > 10 %
```

Filtres prévus :

### Identification

* type ;
* secteur ;
* devise ;
* place de cotation.

### Valorisation

* capitalisation min/max ;
* VE min/max ;
* VE / Capitalisation min/max.

### Endettement

* dette nette min/max ;
* taux d'endettement min/max.

### Dividende

* rendement min/max.

### Performance

* performance période min/max ;
* performance 1 semaine ;
* performance 1 mois ;
* performance 6 mois ;
* performance 12 mois ;
* performance 60 mois ;
* performance Max.

---

# 22. Tri

Les colonnes numériques doivent être triables.

Exemples :

* cours ;
* capitalisation ;
* dette ;
* VE ;
* rendement ;
* performances ;
* ratio d'endettement.

Le tri doit être visuellement identifiable.

Le tri et les filtres doivent être compatibles.

---

# 23. Fiche détaillée d'un titre

Chaque titre dispose d'une fiche détaillée.

Structure :

```text
Apple Inc.
AAPL

NASDAQ
USD

227,50 €

+14,2 % sur 6 mois

────────────────────────

Évolution

[ graphique ]

Semaine | Mois | 6M | 1A | 5A | Max

────────────────────────

Valorisation

Capitalisation
VE
VE / Capitalisation

────────────────────────

Endettement

Dette nette
Taux d'endettement

────────────────────────

Dividende

Dividende annuel
Rendement

────────────────────────

Activité

Description
```

---

# 24. Actions et ETF

Waddlers doit gérer au minimum deux types d'instruments :

* Action ;
* ETF.

Le type est enregistré avec le titre.

L'utilisateur doit pouvoir filtrer le tableau par type.

Certains indicateurs peuvent être indisponibles pour certains types d'instruments.

Dans ce cas :

```text
—
```

doit être affiché plutôt que `0`.

---

# 25. Données de marché

Les données de marché sont fournies par un ou plusieurs fournisseurs externes.

Waddlers doit isoler cette dépendance derrière une couche d'abstraction.

Exemple conceptuel :

```text
MarketDataProvider
       │
       ├── Provider A
       ├── Provider B
       └── Provider C
```

Le reste de l'application ne doit pas dépendre directement d'un fournisseur particulier.

Cela permettra de changer de fournisseur sans réécrire le produit.

---

# 26. Cache des données financières

Le cache est une exigence importante du produit.

Waddlers ne doit pas appeler inutilement l'API financière à chaque consultation du dashboard.

Les données financières sont généralement suffisamment stables pour être mises en cache.

## Principe

```text
Utilisateur
     │
     ▼
Waddlers
     │
     ▼
Cache
     │
     ├── donnée disponible
     │       ↓
     │     retourner
     │
     └── donnée absente/expirée
             ↓
       API financière
             ↓
           Cache
             ↓
        PostgreSQL
```

Le cache peut être réalisé avec :

* cache applicatif ;
* TanStack Query côté frontend ;
* cache serveur ;
* PostgreSQL comme stockage persistant.

Si un cache distribué devient nécessaire, Redis pourra être ajouté ultérieurement.

---

# 27. Politique de cache

Le système doit définir un TTL différent selon le type de donnée.

Exemple initial :

| Donnée                 |   TTL indicatif |
| ---------------------- | --------------: |
| Cours actuel           |        5–15 min |
| Historique journalier  |         12–24 h |
| Capitalisation         |         12–24 h |
| Dette                  |            24 h |
| Actionnariat           |            24 h |
| Dividende              |            24 h |
| Secteur                | plusieurs jours |
| Description entreprise | plusieurs jours |

Ces valeurs doivent être configurables.

Le but est de limiter fortement les appels au fournisseur tout en conservant des données suffisamment fraîches.

---

# 28. TanStack Query

TanStack Query doit également être utilisé pour éviter les requêtes inutiles côté frontend.

Exemple :

```text
Dashboard
   │
   ├── portfolio-value
   ├── portfolio-history
   ├── top-gainers
   ├── top-losers
   └── stocks-list
```

Chaque donnée possède une clé de cache appropriée.

Changer de page puis revenir au dashboard ne doit pas provoquer systématiquement une nouvelle récupération des données.

---

# 29. WebSocket

L'architecture doit être compatible avec WebSocket.

Cependant, les WebSockets ne sont pas obligatoires pour le fonctionnement du MVP.

Ils pourront être utilisés ultérieurement pour :

* mise à jour d'un cours ;
* notification de mise à jour de données ;
* invalidation du cache ;
* rafraîchissement automatique du dashboard.

Pour le MVP, une stratégie de cache + rafraîchissement périodique suffit.

---

# 30. Historique des cours

Waddlers doit conserver les historiques de cours nécessaires aux graphiques et calculs.

Granularité MVP :

**journalière**.

Chaque donnée historique doit au minimum comporter :

* instrument ;
* date ;
* cours ;
* devise.

Le système pourra ultérieurement gérer une granularité intraday.

---

# 31. Calcul des performances

Les performances sont calculées selon :

```text
Performance =
((Cours final / Cours initial) - 1) × 100
```

Périodes :

* 1 semaine ;
* 1 mois ;
* 6 mois ;
* 12 mois ;
* 60 mois ;
* Max.

La performance doit utiliser les cours historiques disponibles.

Si aucune donnée suffisamment ancienne n'est disponible :

```text
—
```

doit être affiché.

---

# 32. Valeur globale

La valeur globale d'un espace correspond à la somme des valeurs actuelles des titres suivis.

Pour chaque titre :

```text
Valeur = Quantité × Cours actuel
```

Les valeurs sont converties dans la devise de référence de l'espace.

Le système ne gère pas :

* achats ;
* ventes ;
* ordres ;
* frais de courtage ;
* liquidités bancaires ;
* relevés bancaires.

La valeur affichée représente donc une **valeur de suivi calculée à partir des positions configurées dans Waddlers**.

---

# 33. Quantités suivies

Un titre peut être associé à une quantité dans un espace.

Exemple :

```text
NVIDIA

Quantité : 25
Cours : 180 €
Valeur suivie : 4 500 €
```

L'utilisateur peut modifier directement la quantité suivie.

Aucun historique d'achat ou de vente n'est nécessaire dans le MVP.

---

# 34. Conversion des devises

Pour les titres cotés dans différentes devises, Waddlers doit conserver :

* devise locale ;
* taux de change ;
* valeur convertie en EUR.

Exemple :

```text
Cours : 250 USD
USD/EUR : 0,85
Cours EUR : 212,50 €
```

Les taux de change doivent eux aussi pouvoir être mis en cache.

---

# 35. Places de cotation

Un instrument possède une place de cotation retenue.

Données :

* place ;
* code ;
* devise ;
* logique de sélection.

Exemple :

```text
Apple Inc.

Code : AAPL
Place : NASDAQ
Devise : USD

Logique :
Place principale retenue pour la cotation US.
```

---

# 36. États d'interface

Chaque composant doit gérer :

### Chargement

Afficher un skeleton ou indicateur discret.

### Aucune donnée

Exemple :

> Aucun titre dans cet espace.

### Erreur

Exemple :

> Les données financières ne sont actuellement pas disponibles.

Les erreurs techniques ne doivent pas être exposées directement à l'utilisateur.

### Donnée indisponible

Utiliser :

`—`

et non `0`.

---

# 37. Notifications

`react-toastify` doit être utilisé pour les événements nécessitant un retour immédiat.

Exemples :

```text
✓ Configuration enregistrée

✓ Titre ajouté

✓ Quantité mise à jour

⚠ Impossible de récupérer les données financières

✕ Impossible d'enregistrer les modifications
```

Les notifications ne doivent pas être utilisées pour chaque chargement de données.

---

# 38. Performance

Waddlers doit rester performant avec plusieurs centaines voire plusieurs milliers de titres.

Le frontend ne doit pas charger inutilement l'intégralité des données historiques.

Le tableau doit utiliser :

* pagination ;
* requêtes serveur ;
* virtualisation si nécessaire.

Les calculs lourds doivent être réalisés côté serveur.

---

# 39. Responsive

Desktop :

> expérience principale.

Tablette :

> dashboard adapté.

Mobile :

> consultation et analyse rapide.

Le tableau peut utiliser un scroll horizontal sur mobile plutôt que de supprimer arbitrairement des informations.

---

# 40. Navigation

Navigation principale :

```text
Waddlers

Dashboard
Titres
Espaces
Paramètres
```

Le choix de l'espace actif doit rester accessible depuis la navigation.

---

# 41. Structure technique recommandée

Le projet doit être organisé de manière à séparer clairement :

```text
Frontend
    ↓
oRPC
    ↓
Application / Business Logic
    ↓
Repositories
    ↓
PostgreSQL
```

Les données financières doivent suivre une autre branche :

```text
Market Data Provider
        ↓
Market Data Service
        ↓
Cache
        ↓
PostgreSQL
        ↓
Business Logic
        ↓
oRPC
        ↓
Frontend
```

Le frontend ne doit jamais appeler directement une API financière externe.

---

# 42. Infrastructure

Technologies :

* Docker ;
* Docker Compose ;
* GitHub Actions (CI) ;
* pnpm.

Le projet doit pouvoir être démarré facilement en environnement de développement avec Docker Compose.

Services potentiels :

```text
waddlers-web
waddlers-api
postgresql
```

Redis n'est pas obligatoire dans le MVP.

Il pourra être ajouté lorsque le besoin de cache distribué le justifiera.

---

# 43. Tests

### Tests unitaires

**Vitest**

Tester notamment :

* calculs de performances ;
* conversions de devises ;
* calcul de valeur ;
* règles métier ;
* traitement des données financières.

### Tests E2E

**Playwright**

Scénarios principaux :

* connexion ;
* sélection d'un espace ;
* changement de période ;
* recherche ;
* filtrage ;
* tri ;
* ajout/suppression d'une colonne ;
* modification de l'ordre des colonnes ;
* consultation d'un titre.

---

# 44. Qualité du code

Utiliser :

* ESLint ;
* Prettier ;
* TypeScript strict ;
* pnpm.

Le projet doit éviter les duplications inutiles.

Les composants doivent rester relativement petits et réutilisables.

La logique métier ne doit pas être enfouie dans les composants React.

---

# 45. MVP

Le MVP doit permettre :

### Authentification

* [ ] connexion ;
* [ ] déconnexion ;
* [ ] changement de mot de passe ;
* [ ] utilisateurs créés par l'administrateur.

### Espaces

* [ ] plusieurs espaces ;
* [ ] sélection de l'espace actif ;
* [ ] titres associés à un espace ;
* [ ] quantité suivie.

### Dashboard

* [ ] valeur globale ;
* [ ] évolution globale ;
* [ ] graphique ;
* [ ] sélecteur Semaine / Mois / 6M / 1A / 5A / Max ;
* [ ] meilleures performances ;
* [ ] pires performances.

### Tableau

* [ ] liste des titres ;
* [ ] recherche ;
* [ ] filtres ;
* [ ] tri ;
* [ ] ajout de colonnes ;
* [ ] suppression de colonnes ;
* [ ] réorganisation ;
* [ ] sauvegarde de la configuration.

### Titres

* [ ] actions ;
* [ ] ETF ;
* [ ] fiche détaillée ;
* [ ] graphique historique ;
* [ ] données financières ;
* [ ] performances.

### Données

* [ ] cours ;
* [ ] historique ;
* [ ] conversion EUR ;
* [ ] données financières ;
* [ ] cache ;
* [ ] limitation des appels API.

---

# 46. Hors périmètre

Les fonctionnalités suivantes sont explicitement hors périmètre du MVP :

* passage d'ordre ;
* achat ;
* vente ;
* connexion à un compte bancaire ;
* connexion à un broker ;
* import automatique de transactions ;
* suivi des transactions ;
* comptabilité ;
* calcul fiscal ;
* déclaration fiscale ;
* gestion des liquidités ;
* système de recommandation d'investissement ;
* scoring personnalisé ;
* notifications de trading ;
* trading automatique.

---

# 47. Priorité de développement

## P0 — Fondations

* projet Next.js / TypeScript ;
* PostgreSQL ;
* Drizzle ;
* oRPC ;
* authentification ;
* modèle utilisateur ;
* modèle espace ;
* modèle titre.

## P1 — Données financières

* provider abstraction ;
* récupération des cours ;
* historique ;
* taux de change ;
* cache ;
* stockage PostgreSQL.

## P1 — Dashboard

* valeur globale ;
* graphique ;
* sélecteur de période ;
* meilleures performances ;
* pires performances.

## P1 — Tableau

* TanStack Table ;
* recherche ;
* filtres ;
* tri ;
* colonnes personnalisables ;
* configuration persistante.

## P2 — Fiche titre

* graphique ;
* informations financières ;
* performances ;
* description.

## P2 — Optimisation

* cache avancé ;
* pagination ;
* virtualisation ;
* optimisation des requêtes.

## P3 — Temps réel

* WebSocket ;
* invalidation automatique du cache ;
* données intraday.

---

# 48. Critère produit principal

Le succès de Waddlers ne doit pas être mesuré par le nombre d'informations affichées.

L'objectif est que l'utilisateur puisse ouvrir l'application et comprendre **en quelques secondes** :

1. quelle est la valeur globale de son espace ;
2. comment cette valeur évolue ;
3. quels titres évoluent le plus ;
4. quels titres évoluent le moins ;
5. comment explorer rapidement les caractéristiques de chaque titre.

Le produit doit rester un **dashboard financier clair et configurable**, et non devenir progressivement un ERP financier ou un tableur complexe.

---

# 49. Résumé technique

```text
PROJECT
Waddlers

LANGUAGE
TypeScript

FRONTEND
Next.js
React
Tailwind CSS
shadcn/ui
TanStack Query
TanStack Table
Recharts
React Hook Form
Zod
Zustand
react-toastify

BACKEND
Node.js
TypeScript
oRPC
Zod

DATABASE
PostgreSQL
Drizzle ORM

DATA
Market Data Provider abstraction
Historical market data
Currency rates
Server-side cache
TanStack Query cache

REALTIME
WebSocket-ready
Optional for MVP

INFRASTRUCTURE
Docker
Docker Compose
pnpm
GitHub Actions (CI)

TESTING
Vitest
Playwright

QUALITY
ESLint
Prettier
TypeScript strict
```

# 50. Résumé fonctionnel pour le développeur

**Waddlers est un super-dashboard financier.**

Il permet à un utilisateur authentifié d'ouvrir un espace contenant une liste d'actions et d'ETF, d'en suivre la valeur et l'évolution, puis d'explorer leurs données financières.

Le dashboard possède une **période globale** :

> Semaine / Mois / 6 mois / 1 an / 5 ans / Max

Cette période pilote le graphique et les performances affichées.

L'utilisateur dispose ensuite d'un **tableau entièrement configurable** : il choisit les colonnes, leur ordre, les filtres et le tri.

Les données financières sont récupérées auprès d'un fournisseur externe mais doivent être **fortement mises en cache** afin de limiter les appels API.

L'application ne gère **aucune transaction financière** et ne doit pas être conçue comme une application bancaire.

La priorité absolue est :

> **Clarté → rapidité de lecture → personnalisation → profondeur d'analyse.**

