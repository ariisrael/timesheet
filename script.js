import fs from 'fs'
import dotenv from 'dotenv'
import chalk from 'chalk'

dotenv.config()

const START_DATE = process.env.START_DATE || '2024-07-19'
const END_DATE = process.env.END_DATE || new Date().toISOString().split('T')[0]
const TIME_BETWEEN_COMMITS = parseInt(process.env.TIME_BETWEEN_COMMITS) || 6 // hours between commits to consider a new work day
const USE_CACHED_COMMITS = process.env.USE_CACHED_COMMITS === 'true'
const GITHUB_USER_EMAILS = process.env.GITHUB_USER_EMAILS.split(',')

async function fetchAllCommits(owner, repo, token) {
  let commits = []
  let page = 1
  let fetchMore = true

  // if Commits files already exist, skip fetch and just return the contents of the files
  if (USE_CACHED_COMMITS && fs.existsSync('./allCommits.json')) {
    return JSON.parse(await fs.promises.readFile('./allCommits.json', 'utf8'))
  }

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

function getUserCommits(commits) {
  return commits.filter((commit) => GITHUB_USER_EMAILS.includes(commit.email))
}

async function processCommitsToJSON() {
  const owner = process.env.GITHUB_OWNER
  const repo = process.env.GITHUB_REPO
  const token = process.env.GITHUB_TOKEN

  const allCommits = await fetchAllCommits(owner, repo, token)

  allCommits.sort(
    (a, b) =>
      new Date(`${a.date}T${a.time}${a.tz}`) -
      new Date(`${b.date}T${b.time}${b.tz}`)
  )

  const userCommits = getUserCommits(allCommits)

  const commitsWithTimeSinceLastCommit = userCommits.map((commit, index) => {
    if (index === 0) return { ...commit, timeSinceLastCommit: 0 }
    const previousCommit = userCommits[index - 1]
    const timeSinceLastCommit = getTimeUntilNextCommit(previousCommit, commit)
    return { ...commit, timeSinceLastCommit }
  })

  await fs.promises.writeFile(
    './allCommits.json',
    JSON.stringify(allCommits, null, 2)
  )

  await fs.promises.writeFile(
    './userCommits.json',
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
  const userCommits = JSON.parse(
    await fs.promises.readFile('./userCommits.json', 'utf8')
  )

  return userCommits.reduce((acc, commit) => {
    const commitDate = new Date(`${commit.date}T${commit.time}${commit.tz}`)
    const lastWorkDay = acc.length > 0 ? acc[acc.length - 1] : null

    if (lastWorkDay) {
      const lastCommit = lastWorkDay.commits[lastWorkDay.commits.length - 1]
      const lastCommitDate = new Date(
        `${lastCommit.date}T${lastCommit.time}${lastCommit.tz}`
      )
      const hoursSinceLastCommit =
        (commitDate - lastCommitDate) / (1000 * 60 * 60)

      if (hoursSinceLastCommit > TIME_BETWEEN_COMMITS) {
        acc.push({
          date: commitDate.toISOString().split('T')[0],
          commits: [commit],
        })
      } else {
        lastWorkDay.commits.push(commit)
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

function calculateUserCommitPercentage(userCommits, allCommits) {
  return (userCommits.length / allCommits.length) * 100
}

function calculateUserLOCPercentage(userCommits, allCommits) {
  const userAdditions = userCommits.reduce(
    (sum, commit) => sum + commit.additions,
    0
  )
  const userDeletions = userCommits.reduce(
    (sum, commit) => sum + commit.deletions,
    0
  )

  const userTotalChanges = userAdditions + userDeletions

  const totalAdditions = allCommits.reduce(
    (sum, commit) => sum + commit.additions,
    0
  )
  const totalDeletions = allCommits.reduce(
    (sum, commit) => sum + commit.deletions,
    0
  )
  const totalChanges = totalAdditions + totalDeletions

  return (userTotalChanges / totalChanges) * 100
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

  const allCommits = JSON.parse(
    await fs.promises.readFile('./allCommits.json', 'utf8')
  )
  const userCommits = JSON.parse(
    await fs.promises.readFile('./userCommits.json', 'utf8')
  )
  const commitPercentage = calculateUserCommitPercentage(
    userCommits,
    allCommits
  )
  const locPercentage = calculateUserLOCPercentage(userCommits, allCommits)

  const totalAdditions = userCommits.reduce(
    (sum, commit) => sum + commit.additions,
    0
  )
  const totalDeletions = userCommits.reduce(
    (sum, commit) => sum + commit.deletions,
    0
  )
  const totalChanges = userCommits.reduce(
    (sum, commit) => sum + commit.totalChanges,
    0
  )

  console.log(
    `Timesheet for  ${chalk.green.bold(process.env.GITHUB_USER_EMAILS)}`
  )
  console.log(
    `Between ${chalk.green.bold(START_DATE)} and ${chalk.green.bold(END_DATE)}`
  )
  console.log('='.repeat(80))
  console.log(
    `Longest workday: ${chalk.yellow.bold(longestWorkday.totalHours)} hours`
  )
  console.log('-'.repeat(80))
  console.log(
    `Total lines of code added: ${chalk.magenta.bold(totalAdditions)}`
  )
  console.log(`Total lines of code deleted: ${chalk.red.bold(totalDeletions)}`)
  console.log(`Total lines of code changed: ${chalk.cyan.bold(totalChanges)}`)
  console.log('-'.repeat(80))
  console.log(
    `Percentage of total commits by ${chalk.blue.bold(
      process.env.GITHUB_USER_EMAILS
    )}: ${chalk.blue.bold(commitPercentage.toFixed(2))}%`
  )
  console.log(
    `Percentage of total lines of code changed by ${chalk.green.bold(
      process.env.GITHUB_USER_EMAILS
    )}: ${chalk.green.bold(locPercentage.toFixed(2))}%`
  )
  console.log('='.repeat(80))
  console.log(
    `~${chalk.green.bold(
      Math.floor(Math.abs(hoursInRange))
    )} hours worked by ${chalk.green.bold(
      process.env.GITHUB_USER_EMAILS
    )} between ${chalk.green.bold(START_DATE)} and ${chalk.green.bold(
      END_DATE
    )}`
  )
}

main().catch(console.error)
