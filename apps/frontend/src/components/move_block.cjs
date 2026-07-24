const fs = require('fs');
let content = fs.readFileSync('BusMap.tsx', 'utf-8');
const blockStartStr = '{mode === "bus" && journeyOpen ? (\\n        <section className="journey-card" aria-label="Pesquisar caminho">';
const blockEndStr = '          ) : null}\\n        </section>\\n      ) : null}\\n';
const blockStartIndex = content.indexOf(blockStartStr.replace(/\\n/g, '\n'));
const blockEndIndex = content.indexOf(blockEndStr.replace(/\\n/g, '\n'), blockStartIndex) + blockEndStr.replace(/\\n/g, '\n').length;
let block = content.slice(blockStartIndex, blockEndIndex);
content = content.slice(0, blockStartIndex) + content.slice(blockEndIndex);

block = block.replace(
  '<header>\\n            <div>\\n              <p className="eyebrow">Percurso rápido</p>\\n              <h2>Para onde pretende ir?</h2>\\n            </div>\\n          </header>'.replace(/\\n/g, '\n'),
  '<header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>\\n            <div>\\n              <p className="eyebrow">Percurso rápido</p>\\n              <h2>Para onde pretende ir?</h2>\\n            </div>\\n            <button onClick={() => setIsJourneyExpanded(!isJourneyExpanded)} style={{ background: "transparent", border: "none", color: "#fff", cursor: "pointer", padding: "8px", display: "flex" }}>\\n              <ChevronIcon expanded={!isJourneyExpanded} />\\n            </button>\\n          </header>'.replace(/\\n/g, '\n')
);

block = block.replace(
  '<form className="journey-form" onSubmit={calculateJourney}>',
  '{isJourneyExpanded ? (\\n            <>\\n          <form className="journey-form" onSubmit={calculateJourney}>'.replace(/\\n/g, '\n')
);
block = block.replace(
  '          ) : null}\\n        </section>'.replace(/\\n/g, '\n'),
  '          ) : null}\\n            </>\\n          ) : null}\\n        </section>'.replace(/\\n/g, '\n')
);

const insertionPointStr = '{mode === "metro" ? (\\n          <section className="notice-bar">'.replace(/\\n/g, '\n');
const insertionIndex = content.indexOf(insertionPointStr);
content = content.slice(0, insertionIndex) + block + '\\n        '.replace(/\\n/g, '\n') + content.slice(insertionIndex);

fs.writeFileSync('BusMap.tsx', content);
console.log('done');
