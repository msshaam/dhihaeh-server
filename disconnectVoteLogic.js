function getVoteOutcome({ votes = {}, connectedPlayerIds = [] }) {
  const connectedIds = new Set(connectedPlayerIds);
  const validVotes = Object.entries(votes).filter(([playerId, vote]) => (
    connectedIds.has(playerId) && (vote === 'yes' || vote === 'no')
  ));
  const yesVotes = validVotes.filter(([, vote]) => vote === 'yes').length;
  const noVotes = validVotes.filter(([, vote]) => vote === 'no').length;
  const totalVoters = connectedPlayerIds.length;
  const votedCount = validVotes.length;
  const majority = Math.floor(totalVoters / 2) + 1;

  let result = null;
  if (yesVotes >= majority) result = 'end';
  else if (noVotes >= majority) result = 'wait';
  else if (votedCount >= totalVoters && yesVotes === noVotes) result = 'wait';

  return {
    yesVotes,
    noVotes,
    votedCount,
    totalVoters,
    majority,
    decided: Boolean(result),
    result,
  };
}

module.exports = { getVoteOutcome };
