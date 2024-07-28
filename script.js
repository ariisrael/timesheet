const fs = require('fs')
require('dotenv').config()

const START_DATE = process.env.START_DATE || '2024-07-19'
const END_DATE = process.env.END_DATE || new Date().toISOString().split('T')[0]
const TIME_BETWEEN_COMMITS = parseInt(process.env.TIME_BETWEEN_COMMITS) || 10 // hours between commits to consider a new work day

async function fetchAllCommits(owner, repo, token) {
  let commits = []
  let page = 1
  let fetchMore = true

  while (fetchMore) {
    const url = `https://api.github.com/repos/${owner}/${repo}/commits?per_page=100&page=${page}`
    const headers = {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
    }
    const response = await fetch(url, { headers })
    const data = await response.json()

    if (response.status !== 200) {
      throw new Error(`Failed to fetch commits: ${data.message}`)
    }

    if (data.length > 0) {
      commits = commits.concat(
        await Promise.all(
          data.map(async (commit) => {
            const commitDetails = await fetchCommitDetails(
              owner,
              repo,
              commit.sha,
              token
            )
            return {
              hash: commit.sha,
              name: commit.commit.author.name,
              email: commit.commit.author.email,
              date: commit.commit.author.date.split('T')[0],
              time: commit.commit.author.date.split('T')[1].split('Z')[0],
              tz: '+0000', // GitHub times are in UTC,
              additions: commitDetails.additions,
              deletions: commitDetails.deletions,
              totalChanges: commitDetails.totalChanges,
            }
          })
        )
      )
      page++
    } else {
      fetchMore = false
    }
  }

  console.log(`Total commits fetched: ${commits.length}`)
  return commits
}

async function fetchCommitDetails(owner, repo, sha, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`
  const headers = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
  }
  const response = await fetch(url, { headers })
  const data = await response.json()

  if (response.status !== 200) {
    throw new Error(`Failed to fetch commit details: ${data.message}`)
  }

  const additions = data.stats.additions
  const deletions = data.stats.deletions
  const totalChanges = additions + deletions

  return { additions, deletions, totalChanges }
}

async function processCommitsToJSON() {
  const owner = process.env.GITHUB_OWNER
  const repo = process.env.GITHUB_REPO
  const token = process.env.GITHUB_TOKEN

  const commits = await fetchAllCommits(owner, repo, token)
  commits.sort(
    (a, b) =>
      new Date(`${a.date}T${a.time}${a.tz}`) -
      new Date(`${b.date}T${b.time}${b.tz}`)
  )

  const commitsWithTimeSinceLastCommit = commits.map((commit, index) => {
    if (index === 0) return { ...commit, timeSinceLastCommit: 0 }
    const previousCommit = commits[index - 1]
    const timeSinceLastCommit = getTimeUntilNextCommit(previousCommit, commit)
    return { ...commit, timeSinceLastCommit }
  })

  await fs.promises.writeFile(
    './commits.json',
    JSON.stringify(commitsWithTimeSinceLastCommit, null, 2)
  )
}

function getTimeUntilNextCommit(commit1, commit2) {
  const datetimeStr1 = `${commit1.date}T${commit1.time}${commit1.tz}`
  const datetimeStr2 = `${commit2.date}T${commit2.time}${commit2.tz}`
  const datetime1 = new Date(datetimeStr1)
  const datetime2 = new Date(datetimeStr2)
  return (datetime2 - datetime1) / (1000 * 60 * 60)
}

async function inferWorkDays() {
  const commits = JSON.parse(
    await fs.promises.readFile('./commits.json', 'utf8')
  )

  commits.sort(
    (a, b) =>
      new Date(`${a.date}T${a.time}${a.tz}`) -
      new Date(`${b.date}T${b.time}${b.tz}`)
  )

  return commits.reduce((acc, commit) => {
    const commitDate = new Date(`${commit.date}T${commit.time}${commit.tz}`)
    const lastCommit = acc.length > 0 ? acc[acc.length - 1] : null

    if (lastCommit) {
      const lastCommitDate = new Date(
        `${lastCommit.date}T${
          lastCommit.commits[lastCommit.commits.length - 1].time
        }${lastCommit.commits[lastCommit.commits.length - 1].tz}`
      )
      const hoursSinceLastCommit =
        (commitDate - lastCommitDate) / (1000 * 60 * 60)

      if (hoursSinceLastCommit > TIME_BETWEEN_COMMITS) {
        acc.push({
          date: commitDate.toISOString().split('T')[0],
          commits: [commit],
        })
      } else {
        lastCommit.commits.push(commit)
      }
    } else {
      acc.push({
        date: commitDate.toISOString().split('T')[0],
        commits: [commit],
      })
    }

    return acc
  }, [])
}

function parseDateTime(commit) {
  return new Date(`${commit.date}T${commit.time}${commit.tz}`)
}

function calculateTotalHours(workDays) {
  return workDays.map((workDay) => {
    const commits = workDay.commits
    if (commits.length > 0) {
      const firstCommitTime = parseDateTime(commits[0])
      const lastCommitTime = parseDateTime(commits[commits.length - 1])
      const totalMilliseconds = lastCommitTime - firstCommitTime
      const totalHours = totalMilliseconds / (1000 * 60 * 60)
      return { date: workDay.date, totalHours }
    } else {
      return { date: workDay.date, totalHours: 0 }
    }
  })
}

function calculateTotalHoursInRange(
  hoursPerDay,
  startDate,
  endDate = new Date()
) {
  const start = new Date(startDate)
  const end = new Date(endDate)

  const filteredHours = hoursPerDay.filter((entry) => {
    const entryDate = new Date(entry.date)
    return entryDate >= start && entryDate <= end
  })

  return filteredHours.reduce((acc, entry) => acc + entry.totalHours, 0)
}

function findLongestWorkday(hoursPerDay) {
  return hoursPerDay.reduce(
    (max, day) => (day.totalHours > max.totalHours ? day : max),
    { date: null, totalHours: 0 }
  )
}

function calculateUserCommitPercentage(commits) {
  const userCommits = commits.filter(
    (commit) => commit.email === process.env.GITHUB_USER_EMAIL
  ).length
  const totalCommits = commits.length
  return (userCommits / totalCommits) * 100
}

async function main() {
  await processCommitsToJSON()
  const workDays = await inferWorkDays()
  const hoursWorkedPerDay = calculateTotalHours(workDays)
  const hoursInRange = calculateTotalHoursInRange(
    hoursWorkedPerDay,
    START_DATE,
    END_DATE
  )
  const longestWorkday = findLongestWorkday(hoursWorkedPerDay)

  const commits = JSON.parse(
    await fs.promises.readFile('./commits.json', 'utf8')
  )
  const commitPercentage = calculateUserCommitPercentage(commits)

  const totalAdditions = commits.reduce(
    (sum, commit) => sum + commit.additions,
    0
  )
  const totalDeletions = commits.reduce(
    (sum, commit) => sum + commit.deletions,
    0
  )
  const totalChanges = commits.reduce(
    (sum, commit) => sum + commit.totalChanges,
    0
  )

  console.log(
    `~${Math.floor(Math.abs(hoursInRange))} hours worked by ${
      process.env.GITHUB_USER_EMAIL
    } between ${START_DATE} and ${END_DATE}`
  )
  console.log(
    `Percentage of total commits by ${
      process.env.GITHUB_USER_EMAIL
    }: ${commitPercentage.toFixed(2)}%`
  )
  console.log(`Total lines of code added: ${totalAdditions}`)
  console.log(`Total lines of code deleted: ${totalDeletions}`)
  console.log(`Total lines of code changed: ${totalChanges}`)
}

main().catch(console.error)
