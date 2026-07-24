const fs = require('fs');
let content = fs.readFileSync('BusMap.tsx', 'utf-8');
const lines = content.split(/\r?\n/);
const startIdx = lines.findIndex(l => l.includes('{mode === "bus" && journeyOpen ? ('));
const endIdx = lines.findIndex((l, i) => i > startIdx && l.includes('{favoriteResult ? ('));
const extracted = lines.splice(startIdx, endIdx - startIdx - 1);
let block = extracted.join('\n');

block = block.replace('<header>\\n            <div>\\n              <p className="eyebrow">Percurso rápido</p>\\n              <h2>Para onde pretende ir?</h2>\\n            </div>\\n          </header>'.replace(/\\n/g, '\n'), '<header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>\\n            <div>\\n              <p className="eyebrow">Percurso rápido</p>\\n              <h2>Para onde pretende ir?</h2>\\n            </div>\\n            <button type="button" onClick={() => setIsJourneyExpanded(!isJourneyExpanded)} style={{ background: "transparent", border: "none", color: "#fff", cursor: "pointer", padding: "8px" }}>\\n              <ChevronIcon expanded={!isJourneyExpanded} />\\n            </button>\\n          </header>'.replace(/\\n/g, '\n'));

block = block.replace('<form className="journey-form" onSubmit={calculateJourney}>', '{isJourneyExpanded ? (\\n            <>\\n          <form className="journey-form" onSubmit={calculateJourney}>'.replace(/\\n/g, '\n'));

block = block.replace('          ) : null}\\n        </section>'.replace(/\\n/g, '\n'), '          ) : null}\\n            </>\\n          ) : null}\\n        </section>'.replace(/\\n/g, '\n'));

const insertIdx = lines.findIndex(l => l.includes('{mode === "metro" ? ('));
lines.splice(insertIdx, 0, block + '\n');

fs.writeFileSync('BusMap.tsx', lines.join('\n'));
console.log('Done');
