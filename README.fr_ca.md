<div align="center">
    <h1>Stage and Next</h1>
    <img src="logo.png" alt="Logo de Stage and Next" width="230">
    <br/>

[Read the English version](./README.md)

</div>

## Description

Un seul raccourci pour réviser les modifications Git et les ajouter à l’index dans VS Code.

Appuyez sur **Ctrl+Alt+S** sous Windows ou Linux, ou sur **Cmd+Option+S** sous macOS :

- Si du texte est sélectionné du côté modifié d’une vue de différences, exécutez la commande **Git: Stage Selected Ranges** de VS Code et restez dans le même fichier. Les sélections multiples sont prises en charge.
- Si les sélections sont vides dans une vue de différences, enregistrez le fichier courant, ajoutez-le à l’index, puis ouvrez le prochain fichier comportant des modifications non indexées dans le même dépôt.
- Si la sélection est vide dans la vue Git en lecture seule d’un fichier supprimé, ajoutez sa suppression à l’index et ouvrez le prochain fichier comportant des modifications non indexées.
- Lorsque l’action ouvre un fichier non suivi dans un éditeur de texte ordinaire, continuez d’utiliser le même raccourci pour l’ajouter à l’index et poursuivre la révision.
- Si une ligne de fichier a le focus dans la section **Changes** ou **Untracked Changes** du contrôle de code source (**Source Control**), ajoutez ce fichier à l’index et ouvrez le suivant. Les sélections conservées dans un éditeur inactif n’influencent pas cette action.
- Si tous les éditeurs sont fermés, ouvrez la première modification non indexée sans rien ajouter à l’index. Le dépôt sélectionné dans le contrôle de code source est utilisé en priorité, puis les autres dépôts ouverts qui contiennent des modifications.

Le raccourci n’intercepte pas la saisie dans les fichiers modifiables ordinaires ouverts en dehors de l’action de révision. Un raccourci associé à un caractère, comme l’accent grave, permet donc de saisir ce caractère normalement dans les fichiers Markdown et les autres fichiers. Les vues Git en lecture seule prennent aussi en charge le raccourci, y compris les fichiers supprimés ouverts directement depuis le contrôle de code source. Les onglets de texte ouverts par l’action restent associés à la révision, y compris les fichiers non suivis et les vues de fichiers indexés. Utilisez **Stage and Next: Toggle Enabled** pour saisir le caractère du raccourci dans un onglet de révision. Fermer un onglet de révision modifiable et rouvrir le fichier normalement rétablit l’édition ordinaire.

Vous pouvez aussi exécuter **Stage and Next: Stage Selection or File and Open Next Change** à partir de la palette de commandes ou du menu contextuel d’un fichier modifié dans le contrôle de code source. Les commandes exécutées explicitement prennent aussi en charge les éditeurs de texte ordinaires.

Exécutez **Stage and Next: Toggle Enabled** dans la palette de commandes pour désactiver ou réactiver les actions et libérer leurs raccourcis. Cette préférence est conservée entre les fenêtres et après un rechargement. Vous pouvez aussi modifier **Stage and Next: Enabled** dans les paramètres. La commande de bascule reste accessible lorsque l’extension est désactivée, même si aucun dépôt Git n’est ouvert.

Les titres des commandes et des éléments de l’interface sont conservés en anglais dans ce document pour faciliter leur recherche dans VS Code.

Les fichiers révisés restent ouverts dans des onglets ordinaires. Les boutons **Back/Forward** de la souris et les commandes **Go Back/Go Forward** de VS Code permettent ainsi de revenir aux étapes de la révision. Après l’ajout d’un fichier entier à l’index, l’action remplace sa vue de l’arbre de travail par celle de la section **Staged Changes**, puis ouvre le fichier suivant. Pour les fichiers modifiés ou renommés, cette vue compare **HEAD à l’index**. Revenir en arrière affiche donc les modifications indexées en surbrillance, plutôt qu’une comparaison vide avec l’arbre de travail mis à jour. Les nouveaux fichiers affichent leur contenu dans l’index, et les fichiers supprimés affichent leur contenu dans HEAD, conformément aux vues des fichiers indexés de Git. Ce comportement fonctionne aussi lorsque `git.closeDiffOnOperation` est activé. Fermer vous-même une vue de différences révisée peut retirer son entrée de l’historique natif.

Le raccourci et les menus respectent les choix **View & Sort** du contrôle de code source : vue en liste triée par nom, chemin ou état, ou vue en arborescence avec les dossiers en premier. Par exemple, le tri par nom compare les noms de fichiers entre les dossiers : `src/apple.ts` précède donc `docs/zebra.md`. Après l’ajout du dernier fichier à l’index, l’action ouvre le nouveau dernier fichier restant. Des appuis répétés permettent alors de remonter la liste depuis la fin. Lorsque Git affiche les fichiers non suivis séparément, ils viennent après les fichiers suivis. Les fichiers non suivis masqués sont ignorés. L’ajout à l’index reste limité au dépôt courant et ignore les fichiers déjà indexés. Lorsqu’il ne reste aucune modification non indexée, un message s’affiche dans la barre d’état.

L’ajout de plages sélectionnées utilise le comportement Git natif de VS Code, y compris son traitement des limites de lignes et des modifications non enregistrées. Sélectionnez les plages du côté modifié, à droite. Les sélections dans un document Git en lecture seule affichent des indications et ne provoquent jamais l’ajout du fichier entier à l’index. Les sélections vides fonctionnent des deux côtés. L’ajout d’un fichier entier à l’index enregistre d’abord uniquement le fichier visé. Les conflits de fusion restent pris en charge par les actions de résolution intégrées à VS Code.

## Modifier le raccourci

Ouvrez **Preferences: Open Keyboard Shortcuts**, recherchez `@command:review.stageAndNext` et attribuez votre raccourci aux entrées existantes. Des entrées distinctes sont prévues pour les vues de différences et les onglets de texte ouverts par la révision, le contrôle de code source, l’ouverture d’une modification lorsque tous les éditeurs sont fermés, ainsi que chaque combinaison de vue et de tri. Conservez leurs conditions `when` et leurs `args` : ils transmettent l’ordre de la vue courante et donnent la priorité à la ligne ayant le focus dans le contrôle de code source, plutôt qu’à une sélection dans un éditeur inactif. Les entrées réservées à l’ouverture utilisent `source: "browse"` et évitent d’intercepter la saisie dans les champs de texte, les terminaux et **Quick Open**.

Pour les raccourcis personnalisés existants, ajoutez `config.stageAndNext.enabled` à chaque condition `when` afin que la commande de bascule libère la touche. Les raccourcis d’éditeur doivent aussi comprendre `editorAreaFocus && (isInDiffEditor || stageAndNext.reviewEditor || resourceScheme == git) && editorTextFocus`; les raccourcis réservés à l’ouverture doivent comprendre `!activeEditor` et les exclusions existantes pour les champs de saisie ayant le focus. Les raccourcis définis par l’utilisateur remplacent ceux de l’extension et doivent être mis à jour séparément.

Si vous avez ajouté un raccourci personnalisé pour la version 0.1.0, mettez-le à jour à partir des nouveaux raccourcis par défaut de l’extension pour qu’il transmette aussi `viewOrder`. Un appel direct à `review.stageAndNext` sans `viewOrder` utilise `scm.defaultViewMode` et `scm.defaultViewSortKey`. Les raccourcis et les entrées de menu de l’extension transmettent les choix effectués dans la barre d’outils. La palette de commandes affiche une seule action correspondant à l’ordre de la vue courante.

## Développer et installer hors ligne

Il faut Node.js 22 ou une version ultérieure, ainsi que la version de bureau de VS Code 1.96 ou une version ultérieure, avec son extension Git intégrée activée. Aucune installation de dépendances ni étape de compilation n’est nécessaire.

```sh
npm test
npm run test:integration
npm run package
code-insiders --install-extension ./dist/stage-and-next-0.1.7.vsix --force
```

Vous pouvez aussi exécuter directement `node scripts/package.cjs` sans npm. Le programme de création du paquet inclut uniquement le manifeste, le code source d’exécution, les fichiers README en anglais et en français, le journal des modifications, les licences, les avis de tiers et le logo. Appuyez sur F5 dans ce dossier pour lancer un **Extension Development Host**. Les tests d’intégration natifs lancent un profil VS Code isolé et un dépôt Git temporaire. Définissez `VS_CODE_EXE` si VS Code est installé à un autre emplacement.

## Portée et confidentialité

Cette extension fonctionne localement à l’aide de l’extension Git intégrée à VS Code. Elle ne contient ni télémétrie, ni code réseau, ni identifiants d’accès, ni identifiants de compte, ni dépendances. Elle ajoute des modifications à l’index sans créer de commit, pousser de modifications ni les abandonner. Le code source peut être publié dans un dépôt public conformément aux licences applicables. L’identifiant d’éditeur `review-tools` sert à créer les paquets locaux; choisissez votre propre identifiant d’éditeur enregistré avant de publier sur le Marketplace.

VS Code n’expose pas la ligne ayant le focus dans le contrôle de code source au moyen d’une API publique pour les extensions. Le raccourci du contrôle de code source ouvre brièvement un onglet auxiliaire vide en lecture seule, utilise la commande de sélection de liste de VS Code pour ouvrir la ligne ayant le focus, puis ferme l’onglet auxiliaire. Si un dossier ou un groupe a le focus, aucun autre fichier ouvert n’est ajouté à l’index. La navigation reste limitée au dépôt visé. En vue en arborescence, elle suit l’ordre des fichiers avec les dossiers en premier et ouvre le prochain fichier modifié même si son dossier est réduit. Les vues de différences multifichiers intégrées utilisent l’éditeur de texte actif lorsqu’il y en a un; la vue de différences habituelle par fichier de la section **Changes** demeure le principal mode d’utilisation.

## Licence

À partir de la version 0.1.5, ce projet utilise la **Licence Libre du Québec – Réciprocité, version 1.1 (LiLiQ-R-1.1)**, conformément au modèle du dépôt. Consultez le [texte français](./LICENSE.fr_ca.txt) ou la [traduction anglaise](./LICENSE.txt).

Le code de comparaison provenant de VS Code dans [src/order.cjs](./src/order.cjs) conserve son droit d’auteur de Microsoft et sa licence MIT. Son avis complet et l’avis MIT des versions antérieures du projet sont conservés dans les [avis de tiers](./THIRD_PARTY_NOTICES.md).

## Droits d’auteur

Droits d’auteur appartiennent à © Sa Majesté le Roi du chef du Canada, qui est représenté par le ministre de l’Agriculture et de l’Agroalimentaire, 2026.
