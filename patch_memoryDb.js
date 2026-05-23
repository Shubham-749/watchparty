const fs = require('fs');
let code = fs.readFileSync('server/memoryDb.js', 'utf8');

// Conflict 1 (Lines 11-16)
code = code.replace(/<<<<<<< HEAD\n=======\nconst DatabaseStrategy = require\('\.\/DatabaseStrategy'\);\nconst crypto = require\('crypto'\);\n\n>>>>>>> 441f711 \(added design patterns\)/, "const DatabaseStrategy = require('./DatabaseStrategy');\nconst crypto = require('crypto');");

// Conflict 2 (Lines ~40-100)
// It has my memoryDb logic in HEAD and DatabaseStrategy in 441f711.
// Actually, it's better if I just checkout --theirs and then manually add back the SELECT COUNT(*) and _resetMemoryDb
