### Added

- The build secret scanner reports the file and pattern for each finding. Text findings include a line number. Source map findings point to the physical line of the encoded token in the map. Electron archive findings use a zero-based byte offset. Findings already collected remain available when a source map scan is incomplete.
