import React from 'react';

// Alias for React.createElement -- the codebase is JSX-free on purpose
// (zero build step; plain `node cli.js`).
export const h = React.createElement;
