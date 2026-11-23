// Local no-op bsc plugin: zero dependencies, no network. Trap fixture only.
module.exports = function () {
    return { name: 'noop-plugin' };
};
