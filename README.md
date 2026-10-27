# Marché Rinaorc

Page de l'équipe : prix de la boutique et de l'hôtel des ventes du Skyblock Rinaorc, relevés en jeu par le mod
Pétale de chaque membre. Lecture libre par le lien ; liste d'achats et notes avec le code d'équipe.

- `index.html` et `app.js` : la page, sans dépendance ni compilation.
- Les données viennent du stockage Supabase de l'équipe. La clé de `app.js` est la clé **publique** : elle ne
  permet que de lire ; toute écriture passe par des fonctions qui vérifient le code d'équipe côté serveur.
